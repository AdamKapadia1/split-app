import type { ConfigContext, ExpoConfig } from 'expo/config';

const SENTRY_PLUGIN = '@sentry/react-native/expo';
const PLACEHOLDER_PROJECT = 'YOUR_SENTRY_PROJECT';
const PLACEHOLDER_ORG = 'YOUR_SENTRY_ORG';

function isSentryPlugin(plugin: NonNullable<ExpoConfig['plugins']>[number]) {
  if (plugin === '@sentry/react-native' || plugin === SENTRY_PLUGIN) return true;
  return Array.isArray(plugin) && (plugin[0] === '@sentry/react-native' || plugin[0] === SENTRY_PLUGIN);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const project = process.env.SENTRY_PROJECT?.trim() || PLACEHOLDER_PROJECT;
  const organization = process.env.SENTRY_ORG?.trim() || PLACEHOLDER_ORG;
  const plugins = (config.plugins ?? []).filter((plugin) => !isSentryPlugin(plugin));

  return {
    ...config,
    name: config.name ?? 'Velor',
    slug: config.slug ?? 'split-app',
    plugins: [
      ...plugins,
      [
        SENTRY_PLUGIN,
        {
          url: 'https://sentry.io/',
          project,
          organization,
        },
      ],
    ],
  };
};
