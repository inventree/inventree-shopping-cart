"""API views for the ShoppingCart plugin."""

from django.db.models import BooleanField, Case, Q, Value, When
from django.utils.translation import gettext_lazy as _
from django_filters import rest_framework as rest_filters
from rest_framework import permissions, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from company.models import Company
from data_exporter.mixins import DataExportViewMixin
from InvenTree.api import BulkDeleteMixin
from InvenTree.filters import SEARCH_ORDER_FILTER
from InvenTree.mixins import (
    CreateAPI,
    ListCreateAPI,
    RetrieveAPI,
    RetrieveUpdateDestroyAPI,
)
from InvenTree.permissions import RolePermission
from part.models import Part
from users.permissions import check_user_role

from .models import ShoppingCartEntry
from .serializers import (
    ShoppingCartConvertSerializer,
    ShoppingCartEntrySerializer,
    ShoppingCartRequirementsSerializer,
)


class ShoppingCartEntryPermission(permissions.BasePermission):
    """Object level permissions for cart entries.

    - Any user with access to the cart can read all entries
    - Users can edit or delete their own entries
    - Purchasing users (with 'change' / 'delete' permission) can edit or delete any entry
    """

    def has_object_permission(self, request, view, obj):
        """Check if the user is allowed to modify this particular entry."""
        if request.method in permissions.SAFE_METHODS:
            return True

        user = request.user

        if user.is_superuser or obj.user == user:
            return True

        permission = "delete" if request.method == "DELETE" else "change"

        return check_user_role(user, "purchase_order", permission)


class ShoppingCartEntryMixin:
    """Mixin class for ShoppingCartEntry API endpoints.

    Any user who can view purchase orders can use the shopping cart.
    """

    permission_classes = [
        permissions.IsAuthenticated,
        RolePermission,
        ShoppingCartEntryPermission,
    ]

    role_required = "purchase_order"
    rolemap = {"POST": "view", "PUT": "view", "PATCH": "view", "DELETE": "view"}

    serializer_class = ShoppingCartEntrySerializer
    queryset = ShoppingCartEntry.objects.all()

    def get_queryset(self):
        """Prefetch related fields for the cart entries."""
        queryset = super().get_queryset()

        queryset = queryset.select_related(
            "part",
            "supplier_part",
            "supplier_part__supplier",
            "project_code",
            "destination",
            "user",
        )

        return queryset.annotate(
            overdue=Case(
                When(ShoppingCartEntry.overdue_filter(), then=Value(True)),
                default=Value(False),
                output_field=BooleanField(),
            )
        )


class ShoppingCartEntryFilter(rest_filters.FilterSet):
    """Filter class for the ShoppingCartEntry list endpoint."""

    class Meta:
        """Meta options for this filter set."""

        model = ShoppingCartEntry
        fields = ["part", "supplier_part", "project_code", "destination", "user"]

    mine = rest_filters.BooleanFilter(label="Mine", method="filter_mine")

    def filter_mine(self, queryset, name, value):
        """Filter entries requested by the current user."""
        user = self.request.user

        if value:
            return queryset.filter(user=user)

        return queryset.exclude(user=user)

    has_supplier_part = rest_filters.BooleanFilter(
        label="Has Supplier Part",
        field_name="supplier_part",
        lookup_expr="isnull",
        exclude=True,
    )

    overdue = rest_filters.BooleanFilter(label="Overdue", method="filter_overdue")

    def filter_overdue(self, queryset, name, value):
        """Filter entries which are past their required date."""
        if value:
            return queryset.filter(ShoppingCartEntry.overdue_filter())

        return queryset.exclude(ShoppingCartEntry.overdue_filter())

    supplier = rest_filters.ModelChoiceFilter(
        queryset=Company.objects.filter(is_supplier=True),
        label="Supplier",
        method="filter_supplier",
    )

    def filter_supplier(self, queryset, name, supplier):
        """Filter entries which can be ordered from the given supplier.

        - Entries with a supplier part must match the supplier
        - Entries without a supplier part must have an active supplier part from this supplier
        """
        Q1 = Q(supplier_part__supplier=supplier)
        Q2 = Q(
            supplier_part__isnull=True,
            part__supplier_parts__supplier=supplier,
            part__supplier_parts__active=True,
        )

        return queryset.filter(Q1 | Q2).distinct()


class ShoppingCartEntryList(
    ShoppingCartEntryMixin, BulkDeleteMixin, DataExportViewMixin, ListCreateAPI
):
    """API endpoint for listing and creating cart entries.

    - Supports bulk deletion of multiple entries via a DELETE request
    - Supports data export via a GET request with 'export=true'
    """

    def validate_delete(self, queryset, request) -> None:
        """Enforce object level permissions for bulk deletion.

        The object level permission checks are not applied to list endpoints,
        so they must be enforced here:

        - Users can delete their own entries
        - Purchasing users (with 'delete' permission) can delete any entry

        If *any* of the selected entries cannot be deleted, the entire operation is rejected.
        """
        user = request.user

        if user.is_superuser or check_user_role(user, "purchase_order", "delete"):
            return

        if queryset.exclude(user=user).exists():
            raise PermissionDenied(
                _(
                    "You do not have permission to delete entries requested by other users"
                )
            )

    filterset_class = ShoppingCartEntryFilter

    filter_backends = SEARCH_ORDER_FILTER

    ordering_fields = [
        "pk",
        "part",
        "supplier",
        "supplier_part",
        "quantity",
        "target_date",
        "overdue",
        "project_code",
        "destination",
        "user",
        "created",
    ]

    ordering_field_aliases = {
        "part": "part__name",
        "supplier": "supplier_part__supplier__name",
        "supplier_part": "supplier_part__SKU",
        "project_code": "project_code__code",
        "destination": "destination__pathstring",
        "user": "user__username",
    }

    search_fields = [
        "part__name",
        "part__IPN",
        "part__description",
        "supplier_part__SKU",
        "supplier_part__supplier__name",
        "reason",
        "project_code__code",
    ]


class ShoppingCartEntryDetail(ShoppingCartEntryMixin, RetrieveUpdateDestroyAPI):
    """API endpoint for retrieving, updating and deleting a single cart entry."""


class ShoppingCartRequirements(RetrieveAPI):
    """API endpoint returning the purchase requirements for a particular part.

    Used to suggest a quantity when adding a part to the cart.
    Requires access to both the shopping cart and part information.
    """

    permission_classes = [permissions.IsAuthenticated, RolePermission]
    role_required = "purchase_order"

    serializer_class = ShoppingCartRequirementsSerializer
    queryset = Part.objects.filter(purchaseable=True)

    def check_permissions(self, request):
        """Stock and requirement information also requires 'part' view permission."""
        super().check_permissions(request)

        if not check_user_role(request.user, "part", "view"):
            self.permission_denied(request)


class ShoppingCartConvert(CreateAPI):
    """API endpoint for converting cart entries into a purchase order.

    Requires permission to create purchase orders.
    """

    permission_classes = [permissions.IsAuthenticated, RolePermission]
    role_required = "purchase_order"
    rolemap = {"POST": "add"}

    serializer_class = ShoppingCartConvertSerializer

    def create(self, request, *args, **kwargs):
        """Convert the selected entries, and return the resulting purchase order."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        order = serializer.save()

        return Response(
            {"pk": order.pk, "reference": order.reference},
            status=status.HTTP_201_CREATED,
        )


def construct_urls():
    """Construct the URL patterns for the ShoppingCart plugin."""
    from django.urls import include, path

    return [
        path(
            "cart/",
            include([
                path("convert/", ShoppingCartConvert.as_view(), name="cart-convert"),
                path(
                    "requirements/<int:pk>/",
                    ShoppingCartRequirements.as_view(),
                    name="cart-requirements",
                ),
                path(
                    "<int:pk>/",
                    ShoppingCartEntryDetail.as_view(),
                    name="cart-entry-detail",
                ),
                path("", ShoppingCartEntryList.as_view(), name="cart-entry-list"),
            ]),
        ),
    ]
