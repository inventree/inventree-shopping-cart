# ShoppingCart

Collect purchase requests in a shopping cart, and consolidate them into purchase orders.

Users add *purchase requests* for parts they need to a shared shopping cart. A purchasing officer later reviews the cart, selects multiple requests, and converts them into a purchase order in a single step.

## Installation

### InvenTree Plugin Manager

Install the `inventree-shopping-cart` package from the InvenTree plugin manager, then activate the *Shopping Cart* plugin.

### Command Line

To install manually via the command line, run the following command:

```bash
pip install inventree-shopping-cart
```

## Configuration

This plugin requires InvenTree 1.7.0 or newer, and the following global settings must be enabled:

- **Enable app integration**: The plugin provides a database table, so migrations must be run after activation.
- **Enable URL integration**: The plugin provides custom API endpoints.
- **Enable interface integration**: The plugin provides a custom UI panel.

## Usage

The *Shopping Cart* panel is displayed on the **Purchasing** page.

### Requesting Items

Any user with *view* permission for purchase orders can add items to the cart. Each request records:

| Field | Description |
| --- | --- |
| Part | The (purchaseable) part to be purchased |
| Supplier Part | Preferred supplier part (optional) |
| Quantity | Required quantity, in the units of the part |
| Required Date | Date by which the items are needed (optional) |
| Reason | Reason for the purchase (optional) |
| Project Code | Project code for the purchase (optional) |
| User | The user who made the request (assigned automatically) |

Items can also be added from the detail page of any active, purchaseable part, using the **Add to Cart** button in the page header.

Users can edit or remove their own requests. Users with *change* or *delete* permission for purchase orders can edit or remove any request.

### Creating Purchase Orders

Users with *add* permission for purchase orders can select multiple requests in the cart, and create a purchase order from them. Either:

- Select a **supplier**, to create a new purchase order, or
- Select an existing **pending** purchase order, to add the items to it

For each selected request, a supplier part is determined as follows:

1. If the request specifies a supplier part, it must be from the selected supplier
2. Otherwise, the default supplier part for the part is used (if it is from the selected supplier)
3. Otherwise, the part must have exactly one active supplier part from the selected supplier

If a supplier part cannot be determined for any selected request, no changes are made.

Each request becomes a separate line item. The requested quantity is converted to supplier pack quantity (rounded up to whole packs), and the required date, project code and reason are copied to the line item. If all of the selected requests share a single project code, it is also assigned to a newly created purchase order.

Converted requests are removed from the cart.

## API

| Endpoint | Description |
| --- | --- |
| `/plugin/shopping-cart/cart/` | List and create cart entries |
| `/plugin/shopping-cart/cart/<pk>/` | Retrieve, update or delete a cart entry |
| `/plugin/shopping-cart/cart/convert/` | Convert cart entries into a purchase order |

The list endpoint supports the following filters: `part`, `supplier_part`, `project_code`, `user`, `mine`, `has_supplier_part` and `supplier`.

## Development

Run the unit tests from the InvenTree backend directory:

```bash
INVENTREE_PLUGIN_TESTING=True INVENTREE_PLUGIN_TESTING_SETUP=True python manage.py test shopping_cart
```
