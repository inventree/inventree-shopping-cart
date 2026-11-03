import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { loadLocale } from './locales';

const CART_URL: string = '/plugin/shopping-cart/cart/';

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

  // Requires InvenTree 1.7.0 or newer
  // TODO: Remove cast once the @inventreedb/ui type definitions include openCreate
  const forms = context.forms as InvenTreePluginContext['forms'] & {
    openCreate?: (props: any) => string;
  };

  if (!forms.openCreate) {
    console.error(
      'Shopping Cart: This version of InvenTree does not support forms.openCreate'
    );
    return;
  }

  await loadTranslations(context);

  const projectCodesEnabled: boolean = !!context.globalSettings?.isSet?.(
    'PROJECT_CODES_ENABLED'
  );

  forms.openCreate({
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
      quantity: serverContext.units
        ? { description: t`Required quantity [${serverContext.units}]` }
        : {},
      target_date: {},
      project_code: {
        hidden: !projectCodesEnabled
      },
      reason: {}
    },
    successMessage: t`${serverContext.part_name} added to the shopping cart`
  });
}
