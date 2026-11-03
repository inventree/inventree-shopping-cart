"""API views for the ShoppingCart plugin."""

from django.db.models import Q
from django_filters import rest_framework as rest_filters
from rest_framework import permissions, status
from rest_framework.response import Response

from company.models import Company
from InvenTree.filters import SEARCH_ORDER_FILTER
from InvenTree.mixins import CreateAPI, ListCreateAPI, RetrieveUpdateDestroyAPI
from InvenTree.permissions import RolePermission
from users.permissions import check_user_role

from .models import ShoppingCartEntry
from .serializers import ShoppingCartConvertSerializer, ShoppingCartEntrySerializer


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

        return queryset.select_related(
            "part",
            "supplier_part",
            "supplier_part__supplier",
            "project_code",
            "user",
        )


class ShoppingCartEntryFilter(rest_filters.FilterSet):
    """Filter class for the ShoppingCartEntry list endpoint."""

    class Meta:
        """Meta options for this filter set."""

        model = ShoppingCartEntry
        fields = ["part", "supplier_part", "project_code", "user"]

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


class ShoppingCartEntryList(ShoppingCartEntryMixin, ListCreateAPI):
    """API endpoint for listing and creating cart entries."""

    filterset_class = ShoppingCartEntryFilter

    filter_backends = SEARCH_ORDER_FILTER

    ordering_fields = [
        "pk",
        "part",
        "supplier",
        "supplier_part",
        "quantity",
        "target_date",
        "project_code",
        "user",
        "created",
    ]

    ordering_field_aliases = {
        "part": "part__name",
        "supplier": "supplier_part__supplier__name",
        "supplier_part": "supplier_part__SKU",
        "project_code": "project_code__code",
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
                    "<int:pk>/",
                    ShoppingCartEntryDetail.as_view(),
                    name="cart-entry-detail",
                ),
                path("", ShoppingCartEntryList.as_view(), name="cart-entry-list"),
            ]),
        ),
    ]
