import {
  ApiEndpoints,
  apiUrl,
  type InvenTreePluginContext,
  LocalizedComponent
} from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { type ReactNode, useEffect, useState } from 'react';
import { loadLocale } from './locales';

const CART_URL: string = '/plugin/shopping-cart/cart/';

/**
 * Context data provided by the plugin backend (see core.py:get_ui_primary_actions)
 */
type PartActionContext = {
  part: number;
  part_name: string;
  units?: string;
};

type SelectOption = { value: string; label: string };

/**
 * Simple form for adding a part to the shopping cart.
 *
 * Note: The "primary action" callback is not a React component,
 * so the hook-based form functions (context.forms.create) are not available.
 * Instead, a basic form is rendered within a modal which is opened manually.
 */
function AddToCartForm({
  context,
  part,
  onClose
}: {
  context: InvenTreePluginContext;
  part: PartActionContext;
  onClose: () => void;
}) {
  const projectCodesEnabled: boolean = !!context.globalSettings?.isSet?.(
    'PROJECT_CODES_ENABLED'
  );

  const [quantity, setQuantity] = useState<number | string>(1);
  const [supplierPart, setSupplierPart] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState<string>('');
  const [projectCode, setProjectCode] = useState<string | null>(null);
  const [reason, setReason] = useState<string>('');

  const [supplierParts, setSupplierParts] = useState<SelectOption[]>([]);
  const [projectCodes, setProjectCodes] = useState<SelectOption[]>([]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Load the available supplier parts for this part
  useEffect(() => {
    context.api
      .get(apiUrl(ApiEndpoints.supplier_part_list), {
        params: { part: part.part, active: true, supplier_detail: true }
      })
      .then((response: any) => {
        const results = response.data?.results ?? response.data ?? [];

        setSupplierParts(
          results.map((sp: any) => ({
            value: `${sp.pk}`,
            label: `${sp.supplier_detail?.name ?? '-'} | ${sp.SKU}`
          }))
        );
      })
      .catch(() => setSupplierParts([]));
  }, [part.part]);

  // Load the available project codes
  useEffect(() => {
    if (!projectCodesEnabled) {
      return;
    }

    context.api
      .get(apiUrl(ApiEndpoints.project_code_list))
      .then((response: any) => {
        const results = response.data?.results ?? response.data ?? [];

        setProjectCodes(
          results.map((pc: any) => ({
            value: `${pc.pk}`,
            label: pc.description ? `${pc.code} - ${pc.description}` : pc.code
          }))
        );
      })
      .catch(() => setProjectCodes([]));
  }, [projectCodesEnabled]);

  const submit = () => {
    setSubmitting(true);
    setErrors({});

    context.api
      .post(CART_URL, {
        part: part.part,
        quantity: quantity,
        supplier_part: supplierPart || null,
        target_date: targetDate || null,
        project_code: projectCode || null,
        reason: reason
      })
      .then(() => {
        notifications.show({
          title: t`Added to Cart`,
          message: t`${part.part_name} added to the shopping cart`,
          color: 'green'
        });
        onClose();
      })
      .catch((error: any) => {
        const data = error?.response?.data ?? {};
        const fieldErrors: Record<string, string> = {};

        Object.keys(data).forEach((key: string) => {
          const value = data[key];
          fieldErrors[key] = Array.isArray(value)
            ? value.join(', ')
            : `${value}`;
        });

        if (Object.keys(fieldErrors).length == 0) {
          fieldErrors.non_field_errors = t`Failed to add item to cart`;
        }

        setErrors(fieldErrors);
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Stack gap='sm'>
      <Text fw={500}>{part.part_name}</Text>
      {(errors.non_field_errors || errors.part) && (
        <Text c='red' size='sm'>
          {errors.non_field_errors ?? errors.part}
        </Text>
      )}
      <NumberInput
        label={t`Quantity`}
        description={
          part.units
            ? t`Required quantity [${part.units}]`
            : t`Required quantity`
        }
        required
        min={0}
        value={quantity}
        onChange={setQuantity}
        error={errors.quantity}
      />
      <Select
        label={t`Supplier Part`}
        description={t`Preferred supplier part (optional)`}
        data={supplierParts}
        value={supplierPart}
        onChange={setSupplierPart}
        clearable
        searchable
        error={errors.supplier_part}
      />
      <TextInput
        type='date'
        label={t`Required Date`}
        description={t`Date by which the items are required (optional)`}
        value={targetDate}
        onChange={(event) => setTargetDate(event.currentTarget.value)}
        error={errors.target_date}
      />
      {projectCodesEnabled && (
        <Select
          label={t`Project Code`}
          data={projectCodes}
          value={projectCode}
          onChange={setProjectCode}
          clearable
          searchable
          error={errors.project_code}
        />
      )}
      <Textarea
        label={t`Reason`}
        description={t`Reason for this purchase request (optional)`}
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
        error={errors.reason}
      />
      <Group justify='right'>
        <Button variant='default' onClick={onClose}>
          {t`Cancel`}
        </Button>
        <Button color='green' loading={submitting} onClick={submit}>
          {t`Add to Cart`}
        </Button>
      </Group>
    </Stack>
  );
}

function ModalTitle() {
  return <Text fw={700}>{t`Add to Cart`}</Text>;
}

/**
 * Callback function for the "Add to Cart" primary action on the part detail page.
 */
export function addToCart({
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

  const localize = (children: ReactNode) => (
    <LocalizedComponent
      i18n={context.i18n}
      locale={context.locale}
      loadLocale={loadLocale}
    >
      {children}
    </LocalizedComponent>
  );

  const modalId: string = modals.open({
    title: localize(<ModalTitle />),
    size: 'lg',
    children: localize(
      <AddToCartForm
        context={context}
        part={serverContext}
        onClose={() => modals.close(modalId)}
      />
    )
  });
}
