"""Custom model definitions for the ShoppingCart plugin."""

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models
from django.utils.translation import gettext_lazy as _

import InvenTree.helpers


class ShoppingCartEntry(models.Model):
    """A single pending purchase request in the shopping cart.

    Entries are created by any user who wants something purchased,
    and are later consolidated into purchase orders by a purchasing officer.
    Once an entry has been converted into a purchase order line item,
    it is removed from the cart.
    """

    class Meta:
        """Meta options for the model."""

        app_label = "shopping_cart"
        verbose_name = _("Shopping Cart Entry")
        verbose_name_plural = _("Shopping Cart Entries")
        ordering = ["target_date", "pk"]

    def __str__(self):
        """String representation of the cart entry."""
        return f"{self.quantity} x {self.part.full_name}"

    @classmethod
    def check_user_permission(cls, user, permission: str) -> bool:
        """Custom permission check for this (plugin defined) model.

        Plugin models do not have ruleset definitions, so InvenTree falls back
        to this method (e.g. when checking permission to import data).

        Permissions are mapped onto the 'purchase_order' role:
        - Any user who can view purchase orders can view the cart
        - Other actions (e.g. data import) require the matching role permission,
          as the importer is not subject to the per-entry ownership checks
        """
        from users.permissions import check_user_role

        if permission not in ["view", "add", "change", "delete"]:
            return False

        return check_user_role(user, "purchase_order", permission)

    @staticmethod
    def overdue_filter():
        """Filter for cart entries which are past their required date."""
        today = InvenTree.helpers.current_date()
        return models.Q(target_date__isnull=False, target_date__lt=today)

    @property
    def is_overdue(self) -> bool:
        """Return True if this entry is past its required date."""
        return bool(
            self.target_date and self.target_date < InvenTree.helpers.current_date()
        )

    @staticmethod
    def get_api_url():
        """Return the API URL for this model."""
        return "/plugin/shopping-cart/cart/"

    def save(self, *args, **kwargs):
        """Validate the entry before saving."""
        self.clean()
        super().save(*args, **kwargs)

    def clean(self):
        """Validate the cart entry."""
        super().clean()

        if self.part_id and not self.part.purchaseable:
            raise ValidationError({"part": _("Part must be purchaseable")})

        if self.supplier_part_id:
            if self.supplier_part.part_id != self.part_id:
                raise ValidationError({
                    "supplier_part": _("Supplier part does not match the selected part")
                })

            if not self.supplier_part.active:
                raise ValidationError({
                    "supplier_part": _("Supplier part is not active")
                })

        if self.quantity is not None and self.quantity <= 0:
            raise ValidationError({"quantity": _("Quantity must be greater than zero")})

    part = models.ForeignKey(
        "part.Part",
        on_delete=models.CASCADE,
        related_name="shopping_cart_entries",
        limit_choices_to={"purchaseable": True},
        verbose_name=_("Part"),
        help_text=_("The part to be purchased"),
    )

    supplier_part = models.ForeignKey(
        "company.SupplierPart",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="shopping_cart_entries",
        verbose_name=_("Supplier Part"),
        help_text=_("Preferred supplier part (optional)"),
    )

    quantity = models.DecimalField(
        max_digits=15,
        decimal_places=5,
        validators=[MinValueValidator(0)],
        verbose_name=_("Quantity"),
        help_text=_("Required quantity, in the units of the part"),
    )

    target_date = models.DateField(
        null=True,
        blank=True,
        verbose_name=_("Required Date"),
        help_text=_("Date by which the items are required (optional)"),
    )

    reason = models.CharField(
        max_length=500,
        blank=True,
        default="",
        verbose_name=_("Reason"),
        help_text=_("Reason for this purchase request (optional)"),
    )

    project_code = models.ForeignKey(
        "common.ProjectCode",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="shopping_cart_entries",
        verbose_name=_("Project Code"),
        help_text=_("Project code for this purchase request"),
    )

    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="shopping_cart_entries",
        verbose_name=_("User"),
        help_text=_("User who requested this purchase"),
    )

    created = models.DateTimeField(
        auto_now_add=True,
        null=True,
        verbose_name=_("Created"),
        help_text=_("Date and time this request was created"),
    )
