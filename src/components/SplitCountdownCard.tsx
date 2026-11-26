import { StyleSheet, Text, View } from 'react-native';

import { formatPence } from '@/utils/money';
import type { SplitLedgerState } from '@/utils/settlements';

const HOST = '#818CF8';
const PAID = '#34D399';
const CLAIMED = '#FB923C';
const OPEN = '#3F3F46';

export function SplitCountdownCard({
  ledger,
  hostName,
  reconciled,
}: {
  ledger: SplitLedgerState;
  hostName: string;
  reconciled: boolean;
}) {
  const total = ledger.receiptTotalPence;
  const segments = [
    { key: 'host', pence: ledger.hostConfirmedPence, color: HOST },
    { key: 'paid', pence: ledger.guestPaidPence, color: PAID },
    { key: 'claimed', pence: ledger.guestClaimedUnpaidPence, color: CLAIMED },
    { key: 'open', pence: ledger.remainingUnclaimedPence, color: OPEN },
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.anchor}>
        {`Total bill ${formatPence(ledger.receiptTotalPence)} · Paid outright by ${hostName}`}
      </Text>
      <View style={[styles.trust, reconciled ? styles.trustGood : styles.trustCheck]}>
        <Text style={[styles.trustText, reconciled ? styles.trustTextGood : styles.trustTextCheck]}>
          {reconciled ? 'UK VAT-inclusive · Totals reconciled' : 'UK VAT-inclusive · Totals need a look'}
        </Text>
      </View>
      {ledger.isAllSettled ? (
        <View style={styles.settledRow}>
          <Text style={styles.hero}>{`${formatPence(0)} · All settled`}</Text>
          <View style={styles.settledBadge}>
            <Text style={styles.settledBadgeText}>Settled</Text>
          </View>
        </View>
      ) : (
        <View>
          <Text style={styles.hero}>{formatPence(ledger.remainingToSplitPence)}</Text>
          <Text style={styles.heroLabel}>Remaining to split</Text>
        </View>
      )}
      <View style={styles.track}>
        {segments.map((segment) => (
          <View
            key={segment.key}
            style={{
              width: `${segmentWidth(segment.pence, total)}%`,
              backgroundColor: segment.color,
              height: 8,
            }}
          />
        ))}
      </View>
      <View style={styles.metrics}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{`${formatPence(ledger.remainingUnclaimedPence)} left to claim`}</Text>
          <Text style={styles.metricHint}>{`${ledger.itemsClaimed} of ${ledger.itemsTotal} items claimed`}</Text>
        </View>
        <View style={styles.metricRight}>
          <Text style={styles.metricValue}>{`${formatPence(ledger.remainingOwedToHostPence)} left to pay ${hostName}`}</Text>
        </View>
      </View>
    </View>
  );
}

function segmentWidth(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0D0F15',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    padding: 16,
    gap: 8,
  },
  anchor: { color: '#A1A1AA', fontSize: 13, lineHeight: 18 },
  trust: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  trustGood: { backgroundColor: 'rgba(52, 211, 153, 0.12)' },
  trustCheck: { backgroundColor: 'rgba(129, 140, 248, 0.14)' },
  trustText: { fontSize: 12, fontWeight: '700' },
  trustTextGood: { color: '#34D399' },
  trustTextCheck: { color: '#A5B4FC' },
  hero: { color: '#FAFAFA', fontSize: 36, lineHeight: 42, fontWeight: '700', fontVariant: ['tabular-nums'] },
  heroLabel: { color: '#A1A1AA', fontSize: 13, fontWeight: '600' },
  settledRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  settledBadge: { borderRadius: 999, backgroundColor: 'rgba(52, 211, 153, 0.16)', paddingHorizontal: 10, paddingVertical: 6 },
  settledBadgeText: { color: '#34D399', fontSize: 12, fontWeight: '700' },
  track: { height: 8, borderRadius: 999, overflow: 'hidden', backgroundColor: OPEN, flexDirection: 'row' },
  metrics: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  metric: { flex: 1, gap: 2 },
  metricRight: { flex: 1, alignItems: 'flex-end' },
  metricLabel: { color: '#FAFAFA', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  metricValue: { color: '#FAFAFA', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right' },
  metricHint: { color: '#A1A1AA', fontSize: 12, fontVariant: ['tabular-nums'] },
});
