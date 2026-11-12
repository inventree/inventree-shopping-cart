import {
  ApiEndpoints,
  type ApiFormFieldSet,
  apiUrl,
  type InvenTreePluginContext
} from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const CART_URL: string = '/plugin/shopping-cart/cart/';
export const REQUIREMENTS_URL: string =
  '/plugin/shopping-cart/cart/requirements/';

/**
 * Determine the default destination for a part, based on the part record.
 *
 * - Uses the default location of the part (or of its category)
 * - Structural locations are ignored, as items cannot be received into them
 * - Returns null if no suitable location is available (or it cannot be checked)
 */
async function fetchDefaultDestination(
  context: InvenTreePluginContext,
  part: any
): Promise<number | null> {
  const location = part?.default_location ?? part?.category_default_location;

  if (!location) {
    return null;
  }

  try {
    const response = await context.api.get(
      apiUrl(ApiEndpoints.stock_location_list, location)
    );

    return response.data?.structural ? null : (response.data?.pk ?? null);
  } catch {
    // Location is not available (e.g. no 'stock_location' view permission)
    return null;
  }
}

/**
 * Form fields for creating and editing shopping cart entries.
 *
 * - entryFields: Fields for editing an existing entry
 * - createEntryFields: Fields for creating a new entry, with a suggested quantity
 *   (based on the existing part requirements) for the selected part
 * - setSelectedPart: Set the selected part (e.g. before opening an edit form)
 * - resetCreateFields: Reset the create form state (before opening the create form)
 */
export function useCartEntryFields(context: InvenTreePluginContext) {
  const projectCodesEnabled: boolean = !!context.globalSettings?.isSet?.(
    'PROJECT_CODES_ENABLED'
  );

  const [selectedPart, setSelectedPart] = useState<number | null>(null);

  // Destination for the create form, pre-filled from the default location of the selected part
  const [destination, setDestination] = useState<number | null>(null);
  const destinationRef = useRef<number | null>(null);

  // The destination which was most recently pre-filled
  // (so that it can be replaced if a different part is selected)
  const prefilledDestination = useRef<number | null>(null);

  // Discard stale responses if the selected part changes quickly
  const prefillRequest = useRef<number>(0);

  const updateDestination = useCallback((value: number | null) => {
    destinationRef.current = value;
    setDestination(value);
  }, []);

  const prefillDestination = useCallback(
    (part: any) => {
      const request = ++prefillRequest.current;

      fetchDefaultDestination(context, part).then((location) => {
        if (request !== prefillRequest.current) {
          return;
        }

        // Do not overwrite a destination which was selected by the user
        const current = destinationRef.current;

        if (current == null || current === prefilledDestination.current) {
          prefilledDestination.current = location;
          updateDestination(location);
        }
      });
    },
    [context, updateDestination]
  );

  const resetCreateFields = useCallback(() => {
    prefillRequest.current++;
    prefilledDestination.current = null;
    setSelectedPart(null);
    updateDestination(null);
  }, [updateDestination]);

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
          // Display the primary supplier part first
          ordering: '-primary',
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
      destination: {
        filters: {
          // Received items cannot be placed into a structural location
          structural: false
        }
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

  // Note: Only the create form uses the suggested quantity,
  // and auto-fills the primary supplier part for the selected part
  const createEntryFields: ApiFormFieldSet = useMemo(() => {
    return {
      ...entryFields,
      part: {
        ...entryFields.part,
        onValueChange: (value: any, record: any) => {
          setSelectedPart(value || null);
          prefillDestination(value ? record : null);
        }
      },
      supplier_part: {
        ...entryFields.supplier_part,
        // Only auto-fill once a part is selected,
        // otherwise the primary supplier part of an unrelated part could be selected
        autoFill: !!selectedPart,
        autoFillFilters: {
          primary: true
        }
      },
      quantity: {
        ...entryFields.quantity,
        // Suggest (but do not enter) the quantity - the user can auto-fill from the placeholder
        placeholder: suggestedQuantity
          ? `${suggestedQuantity}`
          : t`Enter quantity to order`,
        placeholderAutofill: !!suggestedQuantity
      },
      destination: {
        ...entryFields.destination,
        value: destination,
        onValueChange: (value: any) => {
          updateDestination(value || null);
        }
      }
    };
  }, [
    entryFields,
    selectedPart,
    suggestedQuantity,
    destination,
    prefillDestination,
    updateDestination
  ]);

  return { entryFields, createEntryFields, setSelectedPart, resetCreateFields };
}
