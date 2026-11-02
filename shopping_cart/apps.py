"""Django config for the ShoppingCart plugin."""

from django.apps import AppConfig


class ShoppingCartConfig(AppConfig):
    """Config class for the ShoppingCart plugin."""

    name = "shopping_cart"

    def ready(self):
        """This function is called whenever the ShoppingCart plugin is loaded."""
        ...
