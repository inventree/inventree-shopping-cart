import {
  ActionButton,
  AddItemButton,
  ApiEndpoints,
  type ApiFormFieldSet,
  apiUrl,
  checkPluginVersion,
  formatDecimal,
  getDetailUrl,
  type InvenTreePluginContext,
  InvenTreeTable,
  LocalizedComponent,
  ModelType,
  RowDeleteAction,
  RowEditAction,
  RowViewAction,
  type TableColumn,
  type TableFilter,
  useTable,
  YesNoButton
} from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { Alert, Center, Group, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconShoppingCartCopy
} from '@tabler/icons-react';
import { useCallback, useMemo, useState } from 'react';
import { loadLocale } from './locales';

const CART_URL: string = '/plugin/shopping-cart/cart/';
const CONVERT_URL: string = '/plugin/shopping-cart/cart/convert/';

/**
 * Render the shopping cart panel on the "purchasing" index page.
 * - Any user can add requests to the cart, and edit their own requests
 * - Purchasing users can convert selected requests into a purchase order
 */
function ShoppingCartPanel({ context }: { context: InvenTreePluginContext }) {
  const tableState = useTable('shopping-cart');

  // Permission information provided by the plugin backend
  const canConvert: boolean = !!context.context?.can_convert;
  const canChange: boolean = !!context.context?.can_change;
  const canDelete: boolean = !!context.context?.can_delete;

  const userId = context.user?.userId?.();

  const projectCodesEnabled: boolean = !!context.globalSettings?.isSet?.(
    'PROJECT_CODES_ENABLED'
  );

  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [selectedPart, setSelectedPart] = useState<number | null>(null);

  const isOwner = useCallback(
    (record: any) => !!userId && record.user == userId,
    [userId]
  );

  const entryFields: ApiFormFieldSet = useMemo(() => {
    return {
      part: {
        filters: {
          purchaseable: true,
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

  const createEntryForm = context.forms.create({
    url: apiUrl(CART_URL),
    title: t`Add to Cart`,
    fields: entryFields,
    successMessage: t`Item added to cart`,
    table: tableState
  });

  const editEntryForm = context.forms.edit({
    url: apiUrl(CART_URL, selectedRecord?.pk),
    title: t`Edit Cart Item`,
    fields: entryFields,
    successMessage: t`Cart item updated`,
    table: tableState
  });

  const deleteEntryForm = context.forms.delete({
    url: apiUrl(CART_URL, selectedRecord?.pk),
    title: t`Remove Cart Item`,
    successMessage: t`Item removed from cart`,
    table: tableState,
    // Users may delete their own entries without the global delete permission
    // The backend enforces the object level permission check
    ignorePermissionCheck: true
  });

  // If all selected entries share a supplier, pre-select it
  const defaultSupplier = useMemo(() => {
    const suppliers = new Set(
      tableState.selectedRecords.map(
        (record: any) => record.supplier_part_detail?.supplier ?? null
      )
    );

    if (suppliers.size == 1) {
      return [...suppliers][0];
    }

    return null;
  }, [tableState.selectedRecords]);

  const [convertSupplier, setConvertSupplier] = useState<number | null>(null);

  const convertForm = context.forms.create({
    url: apiUrl(CONVERT_URL),
    title: t`Create Purchase Order`,
    submitText: t`Create`,
    preFormContent: (
      <Alert color='blue' icon={<IconInfoCircle />}>
        <Text>
          {t`Select a supplier to create a new purchase order, or select an existing pending purchase order to add these items to.`}
        </Text>
        <Text>
          {t`Converted items will be removed from the shopping cart.`}
        </Text>
      </Alert>
    ),
    fields: {
      items: {
        hidden: true,
        value: tableState.selectedIds
      },
      supplier: {
        value: defaultSupplier,
        filters: {
          is_supplier: true,
          active: true
        },
        onValueChange: (value: any) => {
          setConvertSupplier(value || null);
        }
      },
      order: {
        filters: {
          supplier: convertSupplier || undefined,
          // Only "pending" purchase orders can be selected
          status: 10,
          supplier_detail: true
        }
      }
    },
    // Always submit the current table selection
    processFormData: (data: any) => ({
      ...data,
      items: tableState.selectedIds
    }),
    successMessage: null,
    onFormSuccess: (response: any) => {
      tableState.clearSelectedRecords();
      tableState.refreshTable();

      notifications.show({
        title: t`Purchase Order Updated`,
        message: t`Items added to purchase order ${response.reference}`,
        color: 'green'
      });

      if (response.pk) {
        context.navigate(getDetailUrl(ModelType.purchaseorder, response.pk));
      }
    }
  });

  const tableColumns: TableColumn[] = useMemo(() => {
    return [
      {
        accessor: 'part',
        title: t`Part`,
        sortable: true,
        switchable: false,
        render: (record: any) =>
          context.thumbnail({
            src: record.part_detail?.thumbnail,
            text: record.part_detail?.full_name
          })
      },
      {
        accessor: 'part_detail.IPN',
        title: t`IPN`
      },
      {
        accessor: 'part_detail.description',
        title: t`Description`
      },
      {
        accessor: 'supplier',
        title: t`Supplier`,
        sortable: true,
        render: (record: any) =>
          record.supplier_part_detail?.supplier_detail?.name ?? '-'
      },
      {
        accessor: 'supplier_part',
        title: t`Supplier Part`,
        sortable: true,
        render: (record: any) => record.supplier_part_detail?.SKU ?? '-'
      },
      {
        accessor: 'quantity',
        title: t`Quantity`,
        sortable: true,
        switchable: false,
        render: (record: any) => {
          const units = record.part_detail?.units;
          const quantity = formatDecimal(record.quantity);

          return units ? `${quantity} [${units}]` : quantity;
        }
      },
      {
        accessor: 'target_date',
        title: t`Required Date`,
        sortable: true,
        render: (record: any) => {
          if (!record.target_date) {
            return '-';
          }

          if (!record.overdue) {
            return record.target_date;
          }

          return (
            <Group gap='xs' wrap='nowrap'>
              <Text size='sm'>{record.target_date}</Text>
              <Tooltip label={t`Overdue`}>
                <IconAlertTriangle
                  size={16}
                  color='var(--mantine-color-orange-6)'
                  aria-label='cart-entry-overdue'
                />
              </Tooltip>
            </Group>
          );
        }
      },
      {
        accessor: 'overdue',
        title: t`Overdue`,
        sortable: true,
        defaultVisible: false,
        filter: 'overdue',
        render: (record: any) => (
          <Center>
            <YesNoButton value={record.overdue} />
          </Center>
        )
      },
      {
        accessor: 'project_code',
        title: t`Project Code`,
        sortable: true,
        hidden: !projectCodesEnabled,
        render: (record: any) => record.project_code_detail?.code ?? '-'
      },
      {
        accessor: 'reason',
        title: t`Reason`
      },
      {
        accessor: 'user',
        title: t`Requested By`,
        sortable: true,
        render: (record: any) => record.user_detail?.username ?? '-'
      },
      {
        accessor: 'created',
        title: t`Created`,
        sortable: true,
        render: (record: any) =>
          record.created ? new Date(record.created).toLocaleDateString() : '-'
      }
    ];
  }, [projectCodesEnabled]);

  const tableFilters: TableFilter[] = useMemo(() => {
    return [
      {
        name: 'mine',
        label: t`My Requests`,
        description: t`Show requests made by me`
      },
      {
        name: 'user',
        label: t`Requested By`,
        description: t`Show requests made by a specific user`,
        type: 'api',
        apiUrl: apiUrl(ApiEndpoints.user_list),
        apiFilter: { is_active: true },
        model: ModelType.user,
        modelRenderer: (instance: any) => instance.username
      },
      {
        name: 'overdue',
        label: t`Overdue`,
        description: t`Show requests which are past their required date`
      },
      {
        name: 'has_supplier_part',
        label: t`Has Supplier Part`,
        description: t`Show requests which specify a supplier part`
      },
      {
        name: 'supplier',
        label: t`Supplier`,
        description: t`Show requests which can be ordered from a supplier`,
        type: 'api',
        apiUrl: apiUrl(ApiEndpoints.company_list),
        apiFilter: { is_supplier: true },
        model: ModelType.company,
        modelRenderer: (instance: any) => instance.name
      },
      {
        name: 'project_code',
        label: t`Project Code`,
        description: t`Filter by project code`,
        active: projectCodesEnabled,
        type: 'api',
        apiUrl: apiUrl(ApiEndpoints.project_code_list),
        model: ModelType.projectcode,
        modelRenderer: (instance: any) => instance.code
      }
    ];
  }, [projectCodesEnabled]);

  const rowActions = useCallback(
    (record: any) => {
      return [
        RowViewAction({
          title: t`View Part`,
          modelType: ModelType.part,
          modelId: record.part,
          navigate: context.navigate
        }),
        RowEditAction({
          hidden: !isOwner(record) && !canChange,
          onClick: () => {
            setSelectedRecord(record);
            setSelectedPart(record.part);
            editEntryForm.open();
          }
        }),
        RowDeleteAction({
          hidden: !isOwner(record) && !canDelete,
          onClick: () => {
            setSelectedRecord(record);
            deleteEntryForm.open();
          }
        })
      ];
    },
    [isOwner, canChange, canDelete, editEntryForm, deleteEntryForm]
  );

  const tableActions = useMemo(() => {
    return [
      <ActionButton
        key='convert'
        tooltip={t`Create purchase order from selected items`}
        tooltipAlignment='top-start'
        icon={<IconShoppingCartCopy />}
        color='blue'
        hidden={!canConvert}
        disabled={!tableState.hasSelectedRecords}
        onClick={() => {
          setConvertSupplier(defaultSupplier);
          convertForm.open();
        }}
      />,
      <AddItemButton
        key='add'
        tooltip={t`Add item to cart`}
        tooltipAlignment='top-start'
        onClick={() => {
          setSelectedPart(null);
          createEntryForm.open();
        }}
      />
    ];
  }, [canConvert, tableState.hasSelectedRecords, defaultSupplier]);

  return (
    <>
      {createEntryForm.modal}
      {editEntryForm.modal}
      {deleteEntryForm.modal}
      {convertForm.modal}
      <Stack gap='xs'>
        <Alert color='blue' icon={<IconInfoCircle />} title={t`Shopping Cart`}>
          {t`Add items to your shopping cart. These can be converted into purchase orders when ready.`}
        </Alert>
        <InvenTreeTable
          url={apiUrl(CART_URL)}
          tableState={tableState}
          columns={tableColumns}
          context={context}
          props={{
            enableSelection: canConvert,
            params: {},
            rowActions: rowActions,
            tableActions: tableActions,
            tableFilters: tableFilters
          }}
        />
      </Stack>
    </>
  );
}

// This is the function which is called by InvenTree to render the actual panel component
export function RenderShoppingCartPanel(context: InvenTreePluginContext) {
  checkPluginVersion(context);

  return (
    <LocalizedComponent
      i18n={context.i18n}
      locale={context.locale}
      loadLocale={loadLocale}
    >
      <ShoppingCartPanel context={context} />
    </LocalizedComponent>
  );
}
