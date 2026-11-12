import {
  ActionButton,
  AddItemButton,
  ApiEndpoints,
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
  Anchor,
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
  IconFileUpload,
  IconInfoCircle,
  IconLink,
  IconShoppingCartCopy
} from '@tabler/icons-react';
import { useCallback, useMemo, useState } from 'react';
import { CART_URL, useCartEntryFields } from './CartForms';
import { loadLocale } from './locales';

const CONVERT_URL: string = '/plugin/shopping-cart/cart/convert/';

// Model type used by the InvenTree data importer for cart entries
const CART_MODEL_TYPE: string = 'shoppingcartentry';

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
/**
 * Return the URL only if it is an absolute http(s) link,
 * to prevent rendering e.g. "javascript:" URLs from user-supplied data.
 */
function safeExternalUrl(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

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

  const isOwner = useCallback(
    (record: any) => !!userId && record.user == userId,
    [userId]
  );

  const { entryFields, createEntryFields, setSelectedPart, resetCreateFields } =
    useCartEntryFields(context);

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

  // Only entries with a specified supplier part can be converted
  const canConvertSelection: boolean = useMemo(() => {
    return (
      tableState.selectedRecords.length > 0 &&
      tableState.selectedRecords.every((record: any) => !!record.supplier_part)
    );
  }, [tableState.selectedRecords]);

  // Users may only (bulk) delete their own entries, unless they have the 'delete' permission
  // Note: The backend enforces this permission check
  const canDeleteRecord = useCallback(
    (record: any) => canDelete || isOwner(record),
    [canDelete, isOwner]
  );

  // Import cart entries from a file, using the InvenTree data importer
  // Note: Imported entries are assigned to the importing user (enforced by the backend)
  const importEntriesForm = context.forms.create({
    url: apiUrl(ApiEndpoints.import_session_list),
    title: t`Import Cart Items`,
    fields: {
      data_file: {},
      model_type: {
        value: CART_MODEL_TYPE,
        hidden: true
      },
      // Only allow new entries to be created (not existing entries updated)
      update_records: {
        value: false,
        hidden: true
      },
      field_defaults: {
        value: {},
        hidden: true
      },
      field_overrides: {
        value: {},
        hidden: true
      },
      field_filters: {
        value: {
          part: {
            purchaseable: true,
            active: true
          },
          supplier_part: {
            active: true
          }
        },
        hidden: true
      }
    },
    successMessage: null,
    onFormSuccess: (response: any) => {
      context.importer.open(response.pk, {
        onClose: () => tableState.refreshTable()
      });
    }
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
                <Table.Th>{t`Destination`}</Table.Th>
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
                  <Table.Td>
                    {record.destination_detail?.pathstring ?? '-'}
                  </Table.Td>
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
        accessor: 'supplier_part_detail.link',
        title: t`Link`,
        sortable: false,
        render: (record: any) => {
          const url = safeExternalUrl(record.supplier_part_detail?.link);

          if (!url) {
            return '-';
          }

          return (
            <Anchor
              href={url}
              target='_blank'
              rel='noopener noreferrer'
              title={url}
              aria-label='cart-entry-supplier-link'
              onClick={(event: any) => event.stopPropagation()}
            >
              <IconLink size={18} />
            </Anchor>
          );
        }
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
        accessor: 'destination',
        title: t`Destination`,
        sortable: true,
        render: (record: any) => record.destination_detail?.pathstring ?? '-'
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
        name: 'destination',
        label: t`Destination`,
        description: t`Filter by destination location`,
        type: 'api',
        apiUrl: apiUrl(ApiEndpoints.stock_location_list),
        model: ModelType.stocklocation,
        modelRenderer: (instance: any) => instance.pathstring
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
        RowViewAction({
          title: t`View Supplier Part`,
          modelType: ModelType.supplierpart,
          modelId: record.supplier_part,
          navigate: context.navigate,
          hidden: !record.supplier_part
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
          hidden: !canDeleteRecord(record),
          onClick: () => {
            setSelectedRecord(record);
            deleteEntryForm.open();
          }
        })
      ];
    },
    [isOwner, canChange, canDeleteRecord, editEntryForm, deleteEntryForm]
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
        disabled={!canConvertSelection}
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
      <ActionButton
        key='import'
        tooltip={t`Import items from file`}
        tooltipAlignment='top-start'
        icon={<IconFileUpload />}
        // Importing requires the 'change' permission (enforced by the backend)
        hidden={!canChange}
        onClick={() => importEntriesForm.open()}
      />,
      <AddItemButton
        key='add'
        tooltip={t`Add item to cart`}
        tooltipAlignment='top-start'
        onClick={() => {
          resetCreateFields();
          createEntryForm.open();
        }}
      />
    ];
  }, [
    canConvert,
    canChange,
    canConvertSelection,
    selectedSuppliers,
    defaultSupplier
  ]);

  return (
    <>
      {createEntryForm.modal}
      {editEntryForm.modal}
      {deleteEntryForm.modal}
      {convertForm.modal}
      {importEntriesForm.modal}
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
            enableSelection: true,
            enableBulkDelete: true,
            bulkDeleteFilter: canDeleteRecord,
            enableDownload: true,
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
