import { apiUrl, type InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { loadLocale } from './locales';

const CART_URL: string = '/plugin/shopping-cart/cart/';
const REQUIREMENTS_URL: string = '/plugin/shopping-cart/cart/requirements/';

/**
 * Context data provided by the plugin backend (see core.py:get_ui_primary_actions)
 */
type PartActionContext = {
  part: number;
  part_name: string;
  units?: string;
  supplier_part?: number | null;
};

/**
 * Load the plugin translations into the shared i18n instance.
 * This is normally handled by <LocalizedComponent>, but the primary action callback is not a React component.
 * If translations are not available, the (English) source strings are used.
 */
async function loadTranslations(context: InvenTreePluginContext) {
  try {
    const catalog = await loadLocale(context.locale);

    if (catalog?.messages) {
      context.i18n.load(context.locale, catalog.messages);
    }
  } catch {
    // Fall back to the source strings
  }
}

/**
 * Fetch the suggested purchase quantity for a part, based on the existing part requirements.
 * Returns undefined if no quantity can be suggested.
 */
async function fetchSuggestedQuantity(
  context: InvenTreePluginContext,
  part: number
): Promise<number | undefined> {
  try {
    const response = await context.api.get(apiUrl(REQUIREMENTS_URL, part));
    const quantity = Number.parseFloat(response.data?.suggested_quantity);

    return quantity > 0 ? quantity : undefined;
  } catch {
    // Requirements are not available (e.g. no 'part' view permission)
    return undefined;
  }
}

/**
 * Callback function for the "Add to Cart" primary action on the part (or supplier part) detail page.
 *
 * The API form is launched via the plugin context, and rendered by the InvenTree user interface.
 */
export async function addToCart({
  inventreeContext,
  serverContext
}: {
  inventreeContext: InvenTreePluginContext;
  serverContext: PartActionContext;
}) {
  const context = inventreeContext;

  if (!serverContext?.part) {
    return;
  }

  const [, suggestedQuantity] = await Promise.all([
    loadTranslations(context),
    fetchSuggestedQuantity(context, serverContext.part)
  ]);

  const projectCodesEnabled: boolean = !!context.globalSettings?.isSet?.(
    'PROJECT_CODES_ENABLED'
  );

  context.forms.openCreate({
    url: CART_URL,
    title: t`Add to Cart`,
    fields: {
      part: {
        value: serverContext.part,
        disabled: true
      },
      supplier_part: {
        value: serverContext.supplier_part ?? undefined,
        filters: {
          part: serverContext.part,
          active: true,
          part_detail: true,
          supplier_detail: true
        }
      },
      // Note: Only override the server-provided description if units are specified
      quantity: {
        // Suggest (but do not enter) the quantity - the user can auto-fill from the placeholder
        placeholder: suggestedQuantity
          ? `${suggestedQuantity}`
          : t`Enter quantity to order`,
        placeholderAutofill: !!suggestedQuantity,
        ...(serverContext.units
          ? { description: t`Required quantity [${serverContext.units}]` }
          : {})
      },
      target_date: {},
      project_code: {
        hidden: !projectCodesEnabled
      },
      reason: {}
    },
    successMessage: t`${serverContext.part_name} added to the shopping cart`
  });
}
