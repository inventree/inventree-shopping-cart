"""Unit tests for the ShoppingCart plugin."""

from datetime import timedelta
from decimal import Decimal

from django.contrib.auth.models import User

from common.models import InvenTreeSetting, ProjectCode
from company.models import Company, SupplierPart
from InvenTree.helpers import current_date
from InvenTree.unit_test import InvenTreeAPITestCase
from order.models import PurchaseOrder
from order.status_codes import PurchaseOrderStatus
from part.models import Part
from plugin import registry
from stock.models import StockItem

from .models import ShoppingCartEntry

CART_URL = "/plugin/shopping-cart/cart/"
CONVERT_URL = "/plugin/shopping-cart/cart/convert/"
REQUIREMENTS_URL = "/plugin/shopping-cart/cart/requirements/"


class ShoppingCartTestMixin:
    """Common test data for the shopping cart tests."""

    @classmethod
    def setUpTestData(cls):
        """Enable the plugin, and create parts, suppliers and project codes."""
        super().setUpTestData()

        # Plugin URLs must be enabled, and the registry reloaded, for the API to be available
        InvenTreeSetting.set_setting("ENABLE_PLUGINS_URL", True, None)
        registry.reload_plugins()
        registry.set_plugin_state("shopping-cart", True)

        cls.part = Part.objects.create(
            name="Resistor", description="A resistor", purchaseable=True
        )
        cls.cable = Part.objects.create(
            name="Cable", description="A cable", purchaseable=True
        )
        cls.assembly = Part.objects.create(
            name="Assembly", description="Not purchaseable", purchaseable=False
        )

        cls.supplier = Company.objects.create(name="Supplier A", is_supplier=True)
        cls.other_supplier = Company.objects.create(name="Supplier B", is_supplier=True)

        cls.sp_a = SupplierPart.objects.create(
            part=cls.part, supplier=cls.supplier, SKU="RES-A"
        )
        cls.sp_b = SupplierPart.objects.create(
            part=cls.part, supplier=cls.other_supplier, SKU="RES-B"
        )

        # Cable is sold in packs of 10
        cls.sp_cable = SupplierPart.objects.create(
            part=cls.cable, supplier=cls.supplier, SKU="CBL-10", pack_quantity="10"
        )

        cls.project = ProjectCode.objects.create(code="PRJ-001")

        cls.other_user = User.objects.create_user(username="other", password="password")


class ShoppingCartEntryTest(ShoppingCartTestMixin, InvenTreeAPITestCase):
    """Tests for creating and editing cart entries."""

    roles = ["purchase_order.view"]

    def test_permission_required(self):
        """Users without purchase order access cannot use the cart."""
        self.clearRoles()
        self.get(CART_URL, expected_code=403)

    def test_create(self):
        """Create a cart entry - the user is assigned automatically."""
        response = self.post(
            CART_URL,
            {
                "part": self.part.pk,
                "quantity": 5,
                "reason": "For the prototype",
                "project_code": self.project.pk,
                "target_date": "2026-12-01",
                "user": self.other_user.pk,
            },
        )

        entry = ShoppingCartEntry.objects.get(pk=response.data["pk"])

        self.assertEqual(entry.user, self.user)
        self.assertEqual(entry.quantity, 5)
        self.assertEqual(entry.project_code, self.project)
        self.assertIsNotNone(entry.created)

        response = self.get(CART_URL)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["part_detail"]["name"], "Resistor")

    def test_options(self):
        """Form metadata is available to users with purchase order 'view' access."""
        response = self.options(CART_URL, expected_code=200)
        self.assertIn("POST", response.data["actions"])

        # Conversion requires 'add' permission
        response = self.options(CONVERT_URL, expected_code=200)
        self.assertNotIn("POST", response.data.get("actions", {}))

        self.assignRole("purchase_order.add")
        response = self.options(CONVERT_URL, expected_code=200)
        self.assertIn("POST", response.data["actions"])
        self.assertIn("items", response.data["actions"]["POST"])

    def test_validation(self):
        """Invalid entries are rejected."""
        # Non-purchaseable part
        response = self.post(
            CART_URL, {"part": self.assembly.pk, "quantity": 1}, expected_code=400
        )
        self.assertIn("part", response.data)

        # Zero quantity
        response = self.post(
            CART_URL, {"part": self.part.pk, "quantity": 0}, expected_code=400
        )
        self.assertIn("quantity", response.data)

        # Supplier part for a different part
        response = self.post(
            CART_URL,
            {"part": self.part.pk, "supplier_part": self.sp_cable.pk, "quantity": 1},
            expected_code=400,
        )
        self.assertIn("supplier_part", response.data)

    def test_edit_permissions(self):
        """Users can edit their own entries, but not those of other users."""
        mine = ShoppingCartEntry.objects.create(
            part=self.part, quantity=1, user=self.user
        )
        theirs = ShoppingCartEntry.objects.create(
            part=self.part, quantity=1, user=self.other_user
        )

        self.patch(f"{CART_URL}{mine.pk}/", {"quantity": 3})
        self.patch(f"{CART_URL}{theirs.pk}/", {"quantity": 3}, expected_code=403)
        self.delete(f"{CART_URL}{theirs.pk}/", expected_code=403)
        self.delete(f"{CART_URL}{mine.pk}/")

        # Purchasing users can edit any entry
        self.assignRole("purchase_order.change")
        self.patch(f"{CART_URL}{theirs.pk}/", {"quantity": 3})

    def test_export(self):
        """Test data export for cart entries."""
        ShoppingCartEntry.objects.create(
            part=self.part, supplier_part=self.sp_a, quantity=5, user=self.user
        )
        ShoppingCartEntry.objects.create(
            part=self.cable, quantity=2, user=self.other_user
        )

        with self.export_data(CART_URL) as data_file:
            self.process_csv(
                data_file,
                required_cols=["Part", "Supplier Part", "Quantity"],
                required_rows=2,
            )

    def test_import_permission(self):
        """Importing data requires the 'change' permission for purchase orders.

        The importer does not apply the per-entry ownership checks,
        so it is restricted to purchasing users (who can edit any entry).
        """
        from importer.models import DataImportSession
        from importer.registry import supported_models

        self.assertIn("shoppingcartentry", supported_models())

        session = DataImportSession(model_type="shoppingcartentry")

        # User can view purchase orders (and thus use the cart), but not import
        self.assertFalse(session.check_import_permission(self.user))

        self.assignRole("purchase_order.change")
        self.assertTrue(session.check_import_permission(self.user))

    def test_filters(self):
        """Test the custom list filters."""
        ShoppingCartEntry.objects.create(part=self.part, quantity=1, user=self.user)
        ShoppingCartEntry.objects.create(
            part=self.cable, quantity=1, user=self.other_user
        )
        ShoppingCartEntry.objects.create(
            part=self.part, supplier_part=self.sp_b, quantity=1, user=self.other_user
        )

        self.assertEqual(len(self.get(CART_URL, {"mine": True}).data), 1)
        self.assertEqual(len(self.get(CART_URL, {"mine": False}).data), 2)
        self.assertEqual(len(self.get(CART_URL, {"has_supplier_part": True}).data), 1)

        # Filter by requesting user
        response = self.get(CART_URL, {"user": self.other_user.pk})
        self.assertEqual(len(response.data), 2)
        self.assertTrue(
            all(item["user"] == self.other_user.pk for item in response.data)
        )

        # Supplier A can supply the first two entries (but not the third, which specifies supplier B)
        response = self.get(CART_URL, {"supplier": self.supplier.pk})
        self.assertEqual(len(response.data), 2)

        response = self.get(CART_URL, {"supplier": self.other_supplier.pk})
        self.assertEqual(len(response.data), 2)

        # Order by supplier name / SKU
        # Note: Null ordering is database dependent, so only entries with a supplier part are compared
        ShoppingCartEntry.objects.create(
            part=self.part, supplier_part=self.sp_a, quantity=1, user=self.user
        )

        for ordering in ["supplier", "supplier_part"]:
            for prefix, expected in [
                ("", [self.sp_a, self.sp_b]),
                ("-", [self.sp_b, self.sp_a]),
            ]:
                response = self.get(CART_URL, {"ordering": f"{prefix}{ordering}"})
                result = [
                    item["supplier_part"]
                    for item in response.data
                    if item["supplier_part"]
                ]
                self.assertEqual(result, [sp.pk for sp in expected])

        # Search by supplier name
        response = self.get(CART_URL, {"search": "Supplier B"})
        self.assertEqual(len(response.data), 1)

    def test_overdue(self):
        """Test the overdue field, filter and ordering."""
        today = current_date()

        overdue = ShoppingCartEntry.objects.create(
            part=self.part,
            quantity=1,
            user=self.user,
            target_date=today - timedelta(days=1),
        )

        # Entries due today (or with no required date) are not overdue
        for target_date in [today, today + timedelta(days=7), None]:
            ShoppingCartEntry.objects.create(
                part=self.part, quantity=1, user=self.user, target_date=target_date
            )

        response = self.get(CART_URL)
        self.assertEqual(len(response.data), 4)

        for item in response.data:
            self.assertEqual(item["overdue"], item["pk"] == overdue.pk)

        response = self.get(CART_URL, {"overdue": True})
        self.assertEqual([item["pk"] for item in response.data], [overdue.pk])

        response = self.get(CART_URL, {"overdue": False})
        self.assertEqual(len(response.data), 3)
        self.assertNotIn(overdue.pk, [item["pk"] for item in response.data])

        response = self.get(CART_URL, {"ordering": "-overdue"})
        self.assertEqual(response.data[0]["pk"], overdue.pk)

        # The overdue status is also returned for a single entry
        response = self.get(f"{CART_URL}{overdue.pk}/")
        self.assertTrue(response.data["overdue"])


class ShoppingCartRequirementsTest(ShoppingCartTestMixin, InvenTreeAPITestCase):
    """Tests for the suggested quantity calculation."""

    roles = ["purchase_order.view", "part.view"]

    def test_suggested_quantity(self):
        """The suggested quantity accounts for stock and existing cart entries."""
        url = f"{REQUIREMENTS_URL}{self.part.pk}/"

        # No requirements - nothing to order
        response = self.get(url)
        self.assertEqual(response.data["part"], self.part.pk)
        self.assertEqual(Decimal(response.data["suggested_quantity"]), 0)

        self.part.minimum_stock = 50
        self.part.save()

        response = self.get(url)
        self.assertEqual(Decimal(response.data["suggested_quantity"]), 50)

        # Existing stock reduces the shortfall
        StockItem.objects.create(part=self.part, quantity=10)

        # Quantities already in the cart reduce the shortfall
        ShoppingCartEntry.objects.create(part=self.part, quantity=5, user=self.user)

        response = self.get(url)
        self.assertEqual(Decimal(response.data["total_stock"]), 10)
        self.assertEqual(Decimal(response.data["in_cart"]), 5)
        self.assertEqual(Decimal(response.data["suggested_quantity"]), 35)

        # Never suggest a negative quantity
        StockItem.objects.create(part=self.part, quantity=100)
        response = self.get(url)
        self.assertEqual(Decimal(response.data["suggested_quantity"]), 0)

    def test_permissions(self):
        """Part view permission is required, and the part must be purchaseable."""
        self.get(f"{REQUIREMENTS_URL}{self.assembly.pk}/", expected_code=404)

        self.clearRoles()
        self.assignRole("purchase_order.view")
        self.get(f"{REQUIREMENTS_URL}{self.part.pk}/", expected_code=403)


class ShoppingCartConvertTest(ShoppingCartTestMixin, InvenTreeAPITestCase):
    """Tests for converting cart entries into a purchase order."""

    roles = ["purchase_order.view", "purchase_order.add"]

    def test_convert_new_order(self):
        """Convert entries into a new purchase order."""
        e1 = ShoppingCartEntry.objects.create(
            part=self.part,
            quantity=4,
            user=self.other_user,
            reason="Urgent",
            project_code=self.project,
        )
        e2 = ShoppingCartEntry.objects.create(
            part=self.cable, quantity=25, user=self.user, project_code=self.project
        )

        # Not selected - should remain in the cart
        e3 = ShoppingCartEntry.objects.create(part=self.part, quantity=1)

        response = self.post(
            CONVERT_URL, {"items": [e1.pk, e2.pk], "supplier": self.supplier.pk}
        )

        order = PurchaseOrder.objects.get(pk=response.data["pk"])

        self.assertEqual(order.supplier, self.supplier)
        self.assertEqual(order.created_by, self.user)
        self.assertEqual(order.project_code, self.project)
        self.assertEqual(order.lines.count(), 2)

        line = order.lines.get(part=self.sp_a)
        self.assertEqual(line.quantity, 4)
        self.assertEqual(line.notes, "Urgent")
        self.assertEqual(line.project_code, self.project)
        self.assertIn("other", line.reference)

        # 25 units in packs of 10 = 3 packs
        line = order.lines.get(part=self.sp_cable)
        self.assertEqual(line.quantity, Decimal(3))

        self.assertFalse(ShoppingCartEntry.objects.filter(pk__in=[e1.pk, e2.pk]))
        self.assertTrue(ShoppingCartEntry.objects.filter(pk=e3.pk).exists())

    def test_convert_existing_order(self):
        """Convert entries into an existing pending purchase order."""
        order = PurchaseOrder.objects.create(supplier=self.other_supplier)
        entry = ShoppingCartEntry.objects.create(part=self.part, quantity=2)

        self.post(CONVERT_URL, {"items": [entry.pk], "order": order.pk})

        self.assertEqual(order.lines.count(), 1)
        self.assertEqual(order.lines.first().part, self.sp_b)

        # Placed orders cannot be selected
        order.status = PurchaseOrderStatus.PLACED.value
        order.save()

        entry = ShoppingCartEntry.objects.create(part=self.part, quantity=2)
        response = self.post(
            CONVERT_URL, {"items": [entry.pk], "order": order.pk}, expected_code=400
        )
        self.assertIn("order", response.data)

    def test_convert_errors(self):
        """Conversion fails if a supplier part cannot be determined."""
        # Specifies a supplier part from supplier B
        e1 = ShoppingCartEntry.objects.create(
            part=self.part, supplier_part=self.sp_b, quantity=1
        )

        # Cable has no supplier part from supplier B
        e2 = ShoppingCartEntry.objects.create(part=self.cable, quantity=1)

        response = self.post(
            CONVERT_URL,
            {"items": [e1.pk, e2.pk], "supplier": self.supplier.pk},
            expected_code=400,
        )
        self.assertEqual(len(response.data["items"]), 1)

        response = self.post(
            CONVERT_URL,
            {"items": [e1.pk, e2.pk], "supplier": self.other_supplier.pk},
            expected_code=400,
        )
        self.assertEqual(len(response.data["items"]), 1)

        # Must specify a supplier or order
        response = self.post(CONVERT_URL, {"items": [e1.pk]}, expected_code=400)
        self.assertIn("supplier", response.data)

        # Nothing has been created or removed
        self.assertEqual(PurchaseOrder.objects.count(), 0)
        self.assertEqual(ShoppingCartEntry.objects.count(), 2)

    def test_convert_permission(self):
        """Conversion requires permission to create purchase orders."""
        entry = ShoppingCartEntry.objects.create(part=self.part, quantity=1)

        self.clearRoles()
        self.assignRole("purchase_order.view")

        self.post(
            CONVERT_URL,
            {"items": [entry.pk], "supplier": self.supplier.pk},
            expected_code=403,
        )


class ShoppingCartPrimaryActionTest(ShoppingCartTestMixin, InvenTreeAPITestCase):
    """Tests for the "Add to Cart" button on the part detail page."""

    roles = ["purchase_order.view"]

    URL = "/api/plugins/ui/features/primary_action/"

    def setUp(self):
        """Enable the plugin user interface."""
        super().setUp()
        InvenTreeSetting.set_setting("ENABLE_PLUGINS_INTERFACE", True, None)

    def get_actions(self, target_model=None, target_id=None) -> list:
        """Return the cart actions provided for a given page context."""
        params = {"location": "/web/"}

        if target_model is not None:
            params["target_model"] = target_model

        if target_id is not None:
            params["target_id"] = target_id

        response = self.get(self.URL, params)
        return [
            item for item in response.data if item["plugin_name"] == "shopping-cart"
        ]

    def test_part_page(self):
        """The button is displayed for purchaseable parts."""
        actions = self.get_actions("part", self.part.pk)
        self.assertEqual(len(actions), 1)

        action = actions[0]
        self.assertEqual(action["key"], "add-to-cart")
        self.assertEqual(action["context"]["part"], self.part.pk)
        # Note: The source file may be resolved to the hashed build output
        self.assertRegex(action["source"], r"/PartAction(-[\w-]+)?\.js:addToCart$")

    def test_supplier_part_page(self):
        """The button is displayed for supplier parts, with the supplier part pre-selected."""
        actions = self.get_actions("supplierpart", self.sp_a.pk)
        self.assertEqual(len(actions), 1)

        context = actions[0]["context"]
        self.assertEqual(context["part"], self.part.pk)
        self.assertEqual(context["supplier_part"], self.sp_a.pk)

        # The part page does not specify a supplier part
        context = self.get_actions("part", self.part.pk)[0]["context"]
        self.assertIsNone(context["supplier_part"])

        # Inactive supplier part
        self.sp_a.active = False
        self.sp_a.save()
        self.assertEqual(self.get_actions("supplierpart", self.sp_a.pk), [])

        # Supplier part for a non-purchaseable part
        sp = SupplierPart.objects.create(
            part=self.assembly, supplier=self.supplier, SKU="ASM-1"
        )
        self.assertEqual(self.get_actions("supplierpart", sp.pk), [])

    def test_no_button(self):
        """The button is not displayed in other situations."""
        # Non-purchaseable part
        self.assertEqual(self.get_actions("part", self.assembly.pk), [])

        # Non-existent or invalid part
        self.assertEqual(self.get_actions("part", 99999), [])
        self.assertEqual(self.get_actions("part", "abc"), [])
        self.assertEqual(self.get_actions("part"), [])

        # Other pages
        self.assertEqual(self.get_actions("stockitem", self.part.pk), [])
        self.assertEqual(self.get_actions("purchasing"), [])
        self.assertEqual(self.get_actions(), [])

        # User without purchase order access
        self.clearRoles()
        self.assertEqual(self.get_actions("part", self.part.pk), [])


class ShoppingCartDashboardTest(ShoppingCartTestMixin, InvenTreeAPITestCase):
    """Tests for the "Add to Cart" dashboard item."""

    roles = ["purchase_order.view"]

    URL = "/api/plugins/ui/features/dashboard/"

    def setUp(self):
        """Enable the plugin user interface."""
        super().setUp()
        InvenTreeSetting.set_setting("ENABLE_PLUGINS_INTERFACE", True, None)

    def get_items(self) -> list:
        """Return the dashboard items provided by this plugin."""
        response = self.get(self.URL)
        return [
            item for item in response.data if item["plugin_name"] == "shopping-cart"
        ]

    def test_dashboard_item(self):
        """The dashboard item is available to users with purchase order access."""
        items = self.get_items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["key"], "add-to-cart")
        self.assertRegex(
            items[0]["source"],
            r"/Dashboard(-[\w-]+)?\.js:RenderAddToCartDashboardItem$",
        )

        self.clearRoles()
        self.assertEqual(self.get_items(), [])
