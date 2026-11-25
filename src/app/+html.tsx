import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { APP_NAME, APP_TAGLINE } from '@/constants/brand';
import { luxury } from '@/constants/theme';
import { getWebBaseUrl } from '@/lib/url';

const origin = getWebBaseUrl();

export default function Root({ children }: PropsWithChildren) {
  const { headNodes, bodyNodes, htmlAttributes, bodyAttributes } = useServerDocumentContext();

  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>{APP_NAME}</title>
        <meta name="description" content={APP_TAGLINE} />
        <meta name="theme-color" content={luxury.bgCanvas} />
        <meta name="apple-mobile-web-app-title" content={APP_NAME} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="color-scheme" content="dark" />
        <link rel="canonical" href={origin} />
        <meta property="og:title" content={APP_NAME} />
        <meta property="og:description" content={APP_TAGLINE} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={origin} />
        <meta property="og:site_name" content={APP_NAME} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={APP_NAME} />
        <meta name="twitter:description" content={APP_TAGLINE} />
        <ScrollViewStyleReset />
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}
