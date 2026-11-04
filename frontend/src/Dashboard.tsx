import {
  apiUrl,
  checkPluginVersion,
  getBaseUrl,
  type InvenTreePluginContext,
  LocalizedComponent,
  navigateToLink,
  StylishText
} from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { Anchor, Group, RollingNumber } from '@mantine/core';
import { IconShoppingCart } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { CART_URL } from './CartForms';
import { loadLocale } from './locales';

// The shopping cart panel, on the purchasing index page
const CART_PAGE_URL: string = '/purchasing/index/shopping-cart';

/**
 * Dashboard item which allows the user to add a part to the shopping cart
 */
function AddToCartDashboardItem({
  context
}: {
  context: InvenTreePluginContext;
}) {
  // Number of items currently in the cart
  const [count, setCount] = useState<number>(0);

  const refreshCount = useCallback(() => {
    context.api
      .get(apiUrl(CART_URL), { params: { limit: 1 } })
      .then((response: any) => {
        setCount(response.data?.count ?? 0);
      })
      .catch(() => {
        setCount(0);
      });
  }, [context.api]);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  return (
    <>
      <Group
        gap='xs'
        wrap='nowrap'
        justify='space-between'
        align='center'
        style={{ height: '100%' }}
      >
        <Anchor
          underline='never'
          href={`/${getBaseUrl()}${CART_PAGE_URL}`}
          onClick={(event: any) =>
            navigateToLink(CART_PAGE_URL, context.navigate, event)
          }
        >
          <Group gap='xs' wrap='nowrap'>
            <IconShoppingCart />
            <StylishText size='md'>{t`Shopping Cart`}</StylishText>
          </Group>
        </Anchor>
        <RollingNumber
          value={count}
          fz='20px'
          color={context.theme.primaryColor}
        />
      </Group>
    </>
  );
}

// This is the function which is called by InvenTree to render the dashboard item
export function RenderAddToCartDashboardItem(context: InvenTreePluginContext) {
  checkPluginVersion(context);

  return (
    <LocalizedComponent
      i18n={context.i18n}
      locale={context.locale}
      loadLocale={loadLocale}
    >
      <AddToCartDashboardItem context={context} />
    </LocalizedComponent>
  );
}
