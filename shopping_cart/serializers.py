"""API serializers for the ShoppingCart plugin."""

import math
from decimal import Decimal

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Sum
from django.utils.translation import gettext_lazy as _
from rest_framework import serializers

from common.serializers import ProjectCodeSerializer
from company.models import Company, SupplierPart
from company.serializers import CompanyBriefSerializer
from importer.registry import register_importer
from InvenTree.mixins import DataImportExportSerializerMixin
from InvenTree.serializers import InvenTreeDecimalField, InvenTreeModelSerializer
from order.models import PurchaseOrder, PurchaseOrderLineItem
from order.status_codes import PurchaseOrderStatus
from part.models import Part
from part.serializers import PartBriefSerializer
from stock.models import StockLocation
from stock.serializers import LocationBriefSerializer
from users.serializers import UserSerializer

from .models import ShoppingCartEntry


class SupplierPartBriefSerializer(InvenTreeModelSerializer):
    """Minimal supplier part information for display in the cart."""

    class Meta:
        """Meta options for this serializer."""

        model = SupplierPart
        fields = [
            "pk",
            "SKU",
            "supplier",
            "supplier_detail",
            "pack_quantity",
            "link",
        ]

    supplier_detail = CompanyBriefSerializer(source="supplier", read_only=True)


@register_importer()
class ShoppingCartEntrySerializer(
    DataImportExportSerializerMixin, InvenTreeModelSerializer
):
    """Serializer for the ShoppingCartEntry model.

    Supports data import and export:
    - Imported entries are always assigned to the importing user
    """

    class Meta:
        """Meta options for this serializer."""

        model = ShoppingCartEntry
        fields = [
            "pk",
            "part",
            "part_detail",
            "supplier_part",
            "supplier_part_detail",
            "quantity",
            "target_date",
            "overdue",
            "reason",
            "project_code",
            "project_code_detail",
            "destination",
            "destination_detail",
            "user",
            "user_detail",
            "created",
        ]

        read_only_fields = ["user", "created", "overdue"]

    part = serializers.PrimaryKeyRelatedField(
        queryset=Part.objects.filter(purchaseable=True, active=True),
        label=_("Part"),
    )

    supplier_part = serializers.PrimaryKeyRelatedField(
        queryset=SupplierPart.objects.filter(active=True),
        allow_null=True,
        required=False,
        label=_("Supplier Part"),
    )

    destination = serializers.PrimaryKeyRelatedField(
        queryset=StockLocation.objects.filter(structural=False),
        allow_null=True,
        required=False,
        label=_("Destination"),
        help_text=_(
            "Stock location where the received items should be placed (optional)"
        ),
    )

    quantity = InvenTreeDecimalField()

    # Note: The "overdue" queryset annotation (see views.py) is used for ordering
    overdue = serializers.BooleanField(
        source="is_overdue", read_only=True, label=_("Overdue")
    )

    part_detail = PartBriefSerializer(source="part", read_only=True)
    supplier_part_detail = SupplierPartBriefSerializer(
        source="supplier_part", read_only=True, allow_null=True
    )
    project_code_detail = ProjectCodeSerializer(
        source="project_code", read_only=True, allow_null=True
    )
    destination_detail = LocationBriefSerializer(
        source="destination", read_only=True, allow_null=True
    )
    user_detail = UserSerializer(source="user", read_only=True, allow_null=True)

    def validate_quantity(self, quantity):
        """Quantity must be strictly positive."""
        if quantity <= 0:
            raise serializers.ValidationError(_("Quantity must be greater than zero"))

        return quantity

    def validate(self, data):
        """Ensure the supplier part matches the selected part."""
        data = super().validate(data)

        part = data.get("part", getattr(self.instance, "part", None))
        supplier_part = data.get(
            "supplier_part", getattr(self.instance, "supplier_part", None)
        )

        if part and supplier_part and supplier_part.part != part:
            raise serializers.ValidationError({
                "supplier_part": _("Supplier part does not match the selected part")
            })

        return data

    def create(self, validated_data):
        """The requesting user is always the user who created the entry."""
        if request := self.context.get("request", None):
            validated_data["user"] = request.user

        return super().create(validated_data)


class ShoppingCartRequirementsSerializer(serializers.Serializer):
    """Purchase requirements for a particular part.

    The suggested quantity is the shortfall between what is required
    (open build orders, open sales orders and minimum stock level)
    and what is available (stock, incoming purchase orders, and existing cart entries).
    """

    class Meta:
        """Meta options for this serializer."""

        fields = [
            "part",
            "required_for_build_orders",
            "required_for_sales_orders",
            "minimum_stock",
            "total_stock",
            "on_order",
            "in_cart",
            "suggested_quantity",
        ]

    part = serializers.IntegerField(source="pk", read_only=True)

    required_for_build_orders = InvenTreeDecimalField(
        source="required_build_order_quantity", read_only=True
    )
    required_for_sales_orders = InvenTreeDecimalField(
        source="required_sales_order_quantity", read_only=True
    )
    minimum_stock = InvenTreeDecimalField(read_only=True)
    total_stock = InvenTreeDecimalField(read_only=True)
    on_order = InvenTreeDecimalField(read_only=True)
    in_cart = InvenTreeDecimalField(read_only=True)
    suggested_quantity = InvenTreeDecimalField(read_only=True)

    def to_representation(self, instance):
        """Calculate the requirements for the provided part."""
        required_build = Decimal(instance.required_build_order_quantity())
        required_sales = Decimal(instance.required_sales_order_quantity())
        minimum_stock = Decimal(instance.minimum_stock or 0)
        total_stock = Decimal(instance.total_stock)
        on_order = Decimal(instance.on_order)

        in_cart = ShoppingCartEntry.objects.filter(part=instance).aggregate(
            total=Sum("quantity")
        )["total"] or Decimal(0)

        required = required_build + required_sales + minimum_stock
        available = total_stock + on_order + in_cart

        return super().to_representation({
            "pk": instance.pk,
            "required_build_order_quantity": required_build,
            "required_sales_order_quantity": required_sales,
            "minimum_stock": minimum_stock,
            "total_stock": total_stock,
            "on_order": on_order,
            "in_cart": in_cart,
            "suggested_quantity": max(required - available, Decimal(0)),
        })


class ShoppingCartConvertSerializer(serializers.Serializer):
    """Convert a selection of cart entries into purchase order line items.

    Either an existing (pending) purchase order is provided, or a supplier
    is specified and a new purchase order is created for that supplier.
    The selected cart entries are removed once converted.
    """

    class Meta:
        """Meta options for this serializer."""

        fields = [
            "items",
            "supplier",
            "order",
        ]

    items = serializers.PrimaryKeyRelatedField(
        queryset=ShoppingCartEntry.objects.all(),
        many=True,
        required=True,
        label=_("Items"),
        help_text=_("Cart entries to convert into a purchase order"),
    )

    supplier = serializers.PrimaryKeyRelatedField(
        queryset=Company.objects.filter(is_supplier=True, active=True),
        required=False,
        allow_null=True,
        label=_("Supplier"),
        help_text=_("Create a new purchase order for this supplier"),
    )

    order = serializers.PrimaryKeyRelatedField(
        queryset=PurchaseOrder.objects.filter(status=PurchaseOrderStatus.PENDING.value),
        required=False,
        allow_null=True,
        label=_("Purchase Order"),
        help_text=_("Add items to an existing pending purchase order"),
    )

    def validate_items(self, items):
        """At least one entry must be selected."""
        if len(items) == 0:
            raise serializers.ValidationError(_("No items selected"))

        return items

    def validate(self, data):
        """Check that each selected entry can be mapped to a supplier part."""
        data = super().validate(data)

        order = data.get("order", None)
        supplier = data.get("supplier", None)

        if order is None and supplier is None:
            msg = _("Either a supplier or a purchase order must be specified")
            raise serializers.ValidationError({"supplier": msg, "order": msg})

        if order is not None and supplier is not None and order.supplier != supplier:
            raise serializers.ValidationError({
                "order": _("Purchase order supplier does not match selected supplier")
            })

        supplier = order.supplier if order else supplier

        errors = []
        lines = []

        for entry in data["items"]:
            supplier_part = self.resolve_supplier_part(entry, supplier)

            if supplier_part is None:
                errors.append(
                    _(
                        "No supplier part available for '{part}' from '{supplier}'"
                    ).format(part=entry.part.full_name, supplier=supplier.name)
                )
            else:
                lines.append((entry, supplier_part))

        if errors:
            raise serializers.ValidationError({"items": errors})

        data["supplier"] = supplier
        data["lines"] = lines

        return data

    @staticmethod
    def resolve_supplier_part(entry: ShoppingCartEntry, supplier: Company):
        """Determine which supplier part to order for a given cart entry.

        - If the entry specifies a supplier part, it must be from the selected supplier
        - Otherwise, prefer the default supplier part for the part (if from this supplier)
        - Otherwise, use the only active supplier part for this part and supplier
        """
        if entry.supplier_part is not None:
            if entry.supplier_part.supplier == supplier:
                return entry.supplier_part
            return None

        default = entry.part.default_supplier

        if default is not None and default.supplier == supplier and default.active:
            return default

        options = SupplierPart.objects.filter(
            part=entry.part, supplier=supplier, active=True
        )

        if options.count() == 1:
            return options.first()

        return None

    @staticmethod
    def pack_quantity(entry: ShoppingCartEntry, supplier_part: SupplierPart) -> Decimal:
        """Convert the requested quantity (part units) into supplier pack quantity.

        Where the supplier part is sold in packs, round up to a whole number of packs.
        """
        pack_size = supplier_part.pack_quantity_native or Decimal(1)
        quantity = Decimal(entry.quantity) / Decimal(pack_size)

        if pack_size != 1:
            quantity = Decimal(math.ceil(quantity))

        return quantity

    def save(self):
        """Create the purchase order line items and remove the converted entries."""
        data = self.validated_data
        request = self.context["request"]

        order = data.get("order", None)
        supplier = data["supplier"]
        lines = data["lines"]

        project_codes = {entry.project_code for entry, _sp in lines}
        destinations = {entry.destination for entry, _sp in lines}

        try:
            with transaction.atomic():
                # Lock the selected entries, so they cannot be converted twice concurrently
                pks = [entry.pk for entry, _sp in lines]
                locked = ShoppingCartEntry.objects.select_for_update().filter(
                    pk__in=pks
                )

                if len(locked) != len(pks):
                    raise serializers.ValidationError({
                        "items": _("Some items have already been removed from the cart")
                    })

                if order is None:
                    order = PurchaseOrder.objects.create(
                        supplier=supplier,
                        created_by=request.user,
                        description=_("Created from shopping cart"),
                        # Only assign a project code to the order if it is unambiguous
                        project_code=project_codes.pop()
                        if len(project_codes) == 1
                        else None,
                        # Only assign a destination to the order if it is unambiguous
                        destination=destinations.pop()
                        if len(destinations) == 1
                        else None,
                    )

                for entry, supplier_part in lines:
                    quantity = self.pack_quantity(entry, supplier_part)
                    total_price = supplier_part.get_price(quantity)

                    PurchaseOrderLineItem.objects.create(
                        order=order,
                        part=supplier_part,
                        quantity=quantity,
                        purchase_price=total_price / quantity if total_price else None,
                        target_date=entry.target_date,
                        project_code=entry.project_code,
                        destination=entry.destination,
                        notes=entry.reason,
                        reference=self.line_reference(entry),
                    )

                locked.delete()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(serializers.as_serializer_error(exc))

        return order

    @staticmethod
    def line_reference(entry: ShoppingCartEntry) -> str:
        """Construct a line item reference which records who requested the item."""
        if entry.user:
            return str(_("Requested by {user}").format(user=entry.user.username))[:100]

        return ""
