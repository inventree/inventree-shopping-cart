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
  StylishText,
  type TableColumn,
  type TableFilter,
  useTable,
  YesNoButton
} from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Alert,
  Button,
  Center,
  Divider,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  Tooltip
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconShoppingCartCopy
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadLocale } from './locales';

const CART_URL: string = '/plugin/shopping-cart/cart/';
const CONVERT_URL: string = '/plugin/shopping-cart/cart/convert/';
const REQUIREMENTS_URL: string = '/plugin/shopping-cart/cart/requirements/';

/**
 * Format the quantity of a cart entry, including the part units (if specified)
 */
function formatQuantity(record: any) {
  const units = record.part_detail?.units;
  const quantity = formatDecimal(record.quantity);

  return units ? `${quantity} [${units}]` : quantity;
}

/**
 * Format a datetime string as a (local) YYYY-MM-DD date,
 * to match the format of the date-only fields
 */
function formatDate(value?: string | null): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Render the shopping cart panel on the "purchasing" index page.
 * - Any user can add requests to the cart, and edit their own requests
 * - Purchasing users can convert selected requests into a purchase order
 */
function ShoppingCartPanel({ context }: { context: InvenTreePluginContext }) {
  const tableState = useTable('shopping-cart');

  // Note: The thumbnail component uses hooks, so it must be rendered as a component (not called directly)
  const Thumbnail = context.thumbnail;

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

  const createEntryForm = context.forms.create({
    url: apiUrl(CART_URL),
    title: t`Add to Cart`,
    fields: createEntryFields,
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

  // Suppliers specified by the selected entries (entries without a supplier part are ignored)
  const selectedSuppliers: Map<number, string> = useMemo(() => {
    const suppliers = new Map<number, string>();

    for (const record of tableState.selectedRecords) {
      const supplier = record.supplier_part_detail?.supplier_detail;

      if (supplier?.pk) {
        suppliers.set(supplier.pk, supplier.name);
      }
    }

    return suppliers;
  }, [tableState.selectedRecords]);

  // If the selected entries specify a supplier, it is fixed for the conversion
  const defaultSupplier: number | null = useMemo(() => {
    if (selectedSuppliers.size == 1) {
      return [...selectedSuppliers.keys()][0];
    }

    return null;
  }, [selectedSuppliers]);

  const [supplierError, setSupplierError] = useState<boolean>(false);

  // If all selected entries share a project code, pre-select it for a new order
  const defaultProjectCode = useMemo(() => {
    const codes = new Set(
      tableState.selectedRecords.map(
        (record: any) => record.project_code ?? null
      )
    );

    if (codes.size == 1) {
      return [...codes][0];
    }

    return null;
  }, [tableState.selectedRecords]);

  const [convertSupplier, setConvertSupplier] = useState<number | null>(null);

  const convertForm = context.forms.create({
    url: apiUrl(CONVERT_URL),
    title: t`Create Purchase Order`,
    submitText: t`Create`,
    preFormContent: (
      <Stack gap='xs'>
        <Alert color='blue' icon={<IconInfoCircle />}>
          <Text>{t`Select a pending purchase order to add these items to.`}</Text>
          <Text>{t`Selected items will be removed from the shopping cart.`}</Text>
        </Alert>
        <ScrollArea.Autosize mah={250}>
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t`Part`}</Table.Th>
                <Table.Th>{t`Supplier Part`}</Table.Th>
                <Table.Th>{t`Quantity`}</Table.Th>
                <Table.Th>{t`Required Date`}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tableState.selectedRecords.map((record: any) => (
                <Table.Tr key={record.pk}>
                  <Table.Td>
                    <Thumbnail
                      src={record.part_detail?.thumbnail}
                      text={record.part_detail?.full_name}
                    />
                  </Table.Td>
                  <Table.Td>{record.supplier_part_detail?.SKU ?? '-'}</Table.Td>
                  <Table.Td>{formatQuantity(record)}</Table.Td>
                  <Table.Td>{record.target_date ?? '-'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Stack>
    ),
    fields: {
      items: {
        hidden: true,
        value: tableState.selectedIds
      },
      supplier: {
        value: defaultSupplier,
        // Supplier is determined by the selected entries (if specified)
        disabled: !!defaultSupplier,
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
        },
        // Allow a new purchase order to be created directly from this form
        // Note: The supplier is pre-filled from the "supplier" filter above
        addCreateFields: {
          reference: {},
          description: {},
          supplier: {
            disabled: !!defaultSupplier,
            filters: {
              is_supplier: true,
              active: true
            }
          },
          supplier_reference: {},
          project_code: {
            hidden: !projectCodesEnabled,
            value: defaultProjectCode ?? undefined
          },
          target_date: {},
          responsible: {
            filters: {
              is_active: true
            }
          }
        }
      }
    },
    // Always submit the current table selection
    // If an order is selected, its supplier takes precedence over the selected supplier
    processFormData: (data: any) => {
      const { supplier, ...rest } = data;

      return {
        ...rest,
        ...(data.order ? {} : { supplier }),
        items: tableState.selectedIds
      };
    },
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
        render: (record: any) => (
          <Thumbnail
            src={record.part_detail?.thumbnail}
            text={record.part_detail?.full_name}
          />
        )
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
        render: (record: any) => {
          const supplier = record.supplier_part_detail?.supplier_detail;

          if (!supplier) {
            return '-';
          }

          return (
            <Thumbnail
              src={supplier.thumbnail ?? supplier.image}
              text={supplier.name}
            />
          );
        }
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
        render: (record: any) => formatQuantity(record)
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
            <Group gap='xs' wrap='nowrap' justify='space-between'>
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
        render: (record: any) => formatDate(record.created)
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
          // All selected entries must be ordered from the same supplier
          if (selectedSuppliers.size > 1) {
            setSupplierError(true);
            return;
          }

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
  }, [
    canConvert,
    tableState.hasSelectedRecords,
    selectedSuppliers,
    defaultSupplier
  ]);

  return (
    <>
      {createEntryForm.modal}
      {editEntryForm.modal}
      {deleteEntryForm.modal}
      {convertForm.modal}
      <Modal
        size='lg'
        opened={supplierError}
        onClose={() => setSupplierError(false)}
        title={
          <StylishText size='lg'>{t`Cannot Create Purchase Order`}</StylishText>
        }
      >
        <Stack gap='sm'>
          <Divider />
          <Alert color='red' icon={<IconAlertTriangle />}>
            <Text>
              {t`The selected items specify different suppliers. Select items from a single supplier to create a purchase order.`}
            </Text>
          </Alert>
          <Divider />
          <Group justify='right'>
            <Button onClick={() => setSupplierError(false)}>{t`Close`}</Button>
          </Group>
        </Stack>
      </Modal>
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
            // Only entries with a specified supplier part can be converted
            isRecordSelectable: (record: any) => !!record.supplier_part,
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
