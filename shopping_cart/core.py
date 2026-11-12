"""Collect purchase requests in a shopping cart, and consolidate them into purchase orders"""

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin, UserInterfaceMixin
from users.permissions import check_user_role

from . import PLUGIN_VERSION


class ShoppingCart(
    AppMixin, SettingsMixin, UrlsMixin, UserInterfaceMixin, InvenTreePlugin
):
    """ShoppingCart - custom InvenTree plugin."""

    # Plugin metadata
    TITLE = "Shopping Cart"
    NAME = "ShoppingCart"
    SLUG = "shopping-cart"
    DESCRIPTION = "Collect purchase requests in a shopping cart, and consolidate them into purchase orders"
    VERSION = PLUGIN_VERSION

    # Additional project information
    AUTHOR = "Oliver Walters"
    WEBSITE = "https://github.com/inventree/inventree-shopping-cart"
    LICENSE = "MIT"

    # Primary actions receive the target model and ID from 1.7.0
    MIN_VERSION = "1.7.0"

    # Plugin settings (from SettingsMixin)
    # Ref: https://docs.inventree.org/en/latest/plugins/mixins/settings/
    SETTINGS = {
        "REQUIRE_PROJECT_CODE": {
            "name": "Require Project Code",
            "description": "Cart entries must specify a project code (only applies if project codes are enabled)",
            "validator": bool,
            "default": False,
        },
        "REQUIRE_DESTINATION": {
            "name": "Require Destination",
            "description": "Cart entries must specify a destination location",
            "validator": bool,
            "default": False,
        },
        "REQUIRE_REASON": {
            "name": "Require Reason",
            "description": "Cart entries must specify a reason for the purchase",
            "validator": bool,
            "default": False,
        },
    }

    def required_fields(self) -> list[str]:
        """Return the cart entry fields which are required, based on the plugin settings."""
        from common.settings import get_global_setting

        fields = []

        if self.get_setting("REQUIRE_PROJECT_CODE") and get_global_setting(
            "PROJECT_CODES_ENABLED"
        ):
            fields.append("project_code")

        if self.get_setting("REQUIRE_DESTINATION"):
            fields.append("destination")

        if self.get_setting("REQUIRE_REASON"):
            fields.append("reason")

        return fields

    # Custom URL endpoints (from UrlsMixin)
    # Ref: https://docs.inventree.org/en/latest/plugins/mixins/urls/
    def setup_urls(self):
        """Configure custom URL endpoints for this plugin."""
        from .views import construct_urls

        return construct_urls()

    # User interface elements (from UserInterfaceMixin)
    # Ref: https://docs.inventree.org/en/latest/plugins/mixins/ui/

    # Custom UI panels
    def get_ui_panels(self, request, context: dict, **kwargs):
        """Display the shopping cart panel on the purchasing index page."""
        if context.get("target_model") != "purchasing":
            return []

        if not check_user_role(request.user, "purchase_order", "view"):
            return []

        return [
            {
                "key": "shopping-cart",
                "title": "Shopping Cart",
                "description": "Pending purchase requests",
                "icon": "ti:shopping-cart:outline",
                "source": self.plugin_static_file("Panel.js:RenderShoppingCartPanel"),
                "context": {
                    "can_convert": check_user_role(
                        request.user, "purchase_order", "add"
                    ),
                    "can_change": check_user_role(
                        request.user, "purchase_order", "change"
                    ),
                    "can_delete": check_user_role(
                        request.user, "purchase_order", "delete"
                    ),
                },
            }
        ]

    # Custom dashboard items
    def get_ui_dashboard_items(self, request, context: dict, **kwargs):
        """Dashboard item for adding a part to the shopping cart."""
        if not check_user_role(request.user, "purchase_order", "view"):
            return []

        return [
            {
                "key": "add-to-cart",
                "title": "Shopping Cart",
                "description": "Add a part to the shopping cart",
                "icon": "ti:shopping-cart-plus:outline",
                "source": self.plugin_static_file(
                    "Dashboard.js:RenderAddToCartDashboardItem"
                ),
                "options": {"width": 2, "height": 1},
            }
        ]

    def get_cart_target(self, context: dict):
        """Determine the part (and optional supplier part) for the current page.

        Returns a (part, supplier_part) tuple, or (None, None) if the page is not supported.
        """
        from company.models import SupplierPart
        from part.models import Part

        target_model = context.get("target_model")

        try:
            target_id = int(context.get("target_id"))
        except (TypeError, ValueError):
            return None, None

        if target_model == "part":
            return Part.objects.filter(pk=target_id).first(), None

        if target_model == "supplierpart":
            supplier_part = (
                SupplierPart.objects.filter(pk=target_id, active=True)
                .select_related("part")
                .first()
            )

            if supplier_part:
                return supplier_part.part, supplier_part

        return None, None

    # Custom primary action buttons
    def get_ui_primary_actions(self, request, context: dict, **kwargs):
        """Display an "Add to Cart" button on the detail page for a purchaseable part or supplier part."""
        if not check_user_role(request.user, "purchase_order", "view"):
            return []

        part, supplier_part = self.get_cart_target(context)

        if part is None or not part.purchaseable or not part.active:
            return []

        # Pre-fill the destination from the default location of the part (or its category)
        # Items cannot be received into a structural location
        destination = part.get_default_location()

        if destination is not None and destination.structural:
            destination = None

        return [
            {
                "key": "add-to-cart",
                "title": "Add to Cart",
                "description": "Add this part to the shopping cart",
                "icon": "ti:shopping-cart-plus:outline",
                "source": self.plugin_static_file("PartAction.js:addToCart"),
                "context": {
                    "part": part.pk,
                    "part_name": part.full_name,
                    "units": part.units,
                    "supplier_part": supplier_part.pk if supplier_part else None,
                    "destination": destination.pk if destination else None,
                },
            }
        ]
