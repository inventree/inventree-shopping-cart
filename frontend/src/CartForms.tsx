import {
  type ApiFormFieldSet,
  apiUrl,
  type InvenTreePluginContext
} from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { useEffect, useMemo, useState } from 'react';

export const CART_URL: string = '/plugin/shopping-cart/cart/';
export const REQUIREMENTS_URL: string =
  '/plugin/shopping-cart/cart/requirements/';

/**
 * Form fields for creating and editing shopping cart entries.
 *
 * - entryFields: Fields for editing an existing entry
 * - createEntryFields: Fields for creating a new entry, with a suggested quantity
 *   (based on the existing part requirements) for the selected part
 * - setSelectedPart: Set the selected part (e.g. before opening an edit form)
 */
export function useCartEntryFields(context: InvenTreePluginContext) {
  const projectCodesEnabled: boolean = !!context.globalSettings?.isSet?.(
    'PROJECT_CODES_ENABLED'
  );

  const [selectedPart, setSelectedPart] = useState<number | null>(null);

  const entryFields: ApiFormFieldSet = useMemo(() => {
    return {
      part: {
        filters: {
          purchaseable: true,
          virtual: false,
          active: true
        },
        onValueChange: (value: any) => {
          setSelectedPart(value || null);
        }
      },
      supplier_part: {
        disabled: !selectedPart,
        filters: {
          part: selectedPart || undefined,
          active: true,
          part_detail: true,
          supplier_detail: true
        }
      },
      quantity: {},
      target_date: {},
      project_code: {
        hidden: !projectCodesEnabled
      },
      reason: {}
    };
  }, [selectedPart, projectCodesEnabled]);

  // Suggested quantity for the selected part, based on the existing part requirements
  const [suggestedQuantity, setSuggestedQuantity] = useState<number | null>(
    null
  );

  useEffect(() => {
    setSuggestedQuantity(null);

    if (!selectedPart) {
      return;
    }

    let cancelled = false;

    context.api
      .get(apiUrl(REQUIREMENTS_URL, selectedPart))
      .then((response: any) => {
        const quantity = Number.parseFloat(response.data?.suggested_quantity);

        if (!cancelled && quantity > 0) {
          setSuggestedQuantity(quantity);
        }
      })
      .catch(() => {
        // Requirements are not available (e.g. no 'part' view permission)
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPart]);

  // Note: Only the create form uses the suggested quantity
  const createEntryFields: ApiFormFieldSet = useMemo(() => {
    return {
      ...entryFields,
      quantity: {
        ...entryFields.quantity,
        // Suggest (but do not enter) the quantity - the user can auto-fill from the placeholder
        placeholder: suggestedQuantity
          ? `${suggestedQuantity}`
          : t`Enter quantity to order`,
        placeholderAutofill: !!suggestedQuantity
      }
    };
  }, [entryFields, suggestedQuantity]);

  return { entryFields, createEntryFields, setSelectedPart };
}
