import { Redirect, useLocalSearchParams } from 'expo-router';

function firstParam(value: string | string[] | undefined) {
  const picked = Array.isArray(value) ? value[0] : value;
  const trimmed = picked?.trim();
  return trimmed ? trimmed : undefined;
}

/** Keeps older Scan links working after the tab moved to `/scan`. */
export default function ScannerRedirect() {
  const params = useLocalSearchParams<{ groupId?: string | string[]; groupName?: string | string[] }>();
  const groupId = firstParam(params.groupId);
  const groupName = firstParam(params.groupName);

  if (!groupId && !groupName) return <Redirect href="/scan" />;

  return (
    <Redirect
      href={{
        pathname: '/scan',
        params: {
          ...(groupId ? { groupId } : {}),
          ...(groupName ? { groupName } : {}),
        },
      }}
    />
  );
}
