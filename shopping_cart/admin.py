"""Admin site configuration for the ShoppingCart plugin."""

from django.contrib import admin

from .models import ShoppingCartEntry


@admin.register(ShoppingCartEntry)
class ShoppingCartEntryAdmin(admin.ModelAdmin):
    """Admin interface for the ShoppingCartEntry model."""

    list_display = (
        "part",
        "supplier_part",
        "quantity",
        "target_date",
        "project_code",
        "destination",
        "user",
        "created",
    )
    list_filter = ("user", "project_code")
    raw_id_fields = ("part", "supplier_part", "destination")
