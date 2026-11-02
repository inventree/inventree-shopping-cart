"""Collect purchase requests in a shopping cart, and consolidate them into purchase orders"""

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, UrlsMixin, UserInterfaceMixin
from users.permissions import check_user_role

from . import PLUGIN_VERSION


class ShoppingCart(AppMixin, UrlsMixin, UserInterfaceMixin, InvenTreePlugin):
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

    # Plugin panels on the "purchasing" index page were introduced in 1.4.0
    MIN_VERSION = "1.4.0"

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
