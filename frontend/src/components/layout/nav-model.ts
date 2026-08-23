import {
  LayoutDashboard, Wallet, DollarSign, Sprout, Search,
  FileText, Wheat, Package, Beef, Paperclip, User,
  Tag, Map, Clock, MoreHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OverviewCounts } from '../../hooks/useOverviewData';

export type DashboardView =
  | 'overview' | 'fields' | 'expenses' | 'incomes' | 'activities' | 'observations'
  | 'scoutings' | 'reports' | 'harvests' | 'stock' | 'livestock' | 'documents'
  | 'categories' | 'reminders' | 'account';

export interface NavItem {
  key: DashboardView;
  label: string;
  Icon: LucideIcon;
  feature?: string;
  /** Which counter to show as a badge, when there is one. */
  count?: keyof OverviewCounts;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * ONE navigation model, consumed by the sidebar, the mobile tab bar and the
 * "Más" sheet. They used to be two hand-maintained arrays that had already
 * drifted (the sidebar had Stock and Hacienda; the bottom bar silently didn't).
 *
 * The grouping is by the question the user is asking, not by table:
 *   Producción → "¿qué pasó en el lote?"
 *   Plata      → "¿cómo viene la plata?"
 *   Recursos   → "¿qué tengo?"
 * Configuration (Recordatorios, Mi cuenta) sits apart at the foot, because it
 * is not campaign data and should not compete with it.
 *
 * Observaciones is deliberately absent: it is a sub-tab of Actividades now.
 * For someone dictating to a bot, an observación IS an activity on the lote,
 * and two near-identical tables meant looking in two places.
 */
export const PRIMARY: NavItem = { key: 'overview', label: 'Resumen', Icon: LayoutDashboard };

export const GROUPS: NavGroup[] = [
  {
    id: 'produccion',
    label: 'Producción',
    items: [
      { key: 'fields', label: 'Campos y lotes', Icon: Map, count: 'plots' },
      { key: 'activities', label: 'Actividades', Icon: Sprout, feature: 'agronomy', count: 'activities' },
      { key: 'scoutings', label: 'Monitoreos', Icon: Search, feature: 'agronomy', count: 'scoutings' },
      { key: 'harvests', label: 'Cosechas', Icon: Wheat, feature: 'agronomy', count: 'harvests' },
      { key: 'reports', label: 'Reportes', Icon: FileText, feature: 'agronomy' },
    ],
  },
  {
    id: 'plata',
    label: 'Plata',
    items: [
      { key: 'expenses', label: 'Gastos', Icon: Wallet, feature: 'expenses', count: 'expenses' },
      { key: 'incomes', label: 'Ingresos', Icon: DollarSign, feature: 'incomes', count: 'incomes' },
      { key: 'categories', label: 'Categorías', Icon: Tag },
    ],
  },
  {
    id: 'recursos',
    label: 'Recursos',
    items: [
      { key: 'stock', label: 'Stock', Icon: Package, feature: 'stock', count: 'stock' },
      { key: 'livestock', label: 'Hacienda', Icon: Beef, feature: 'livestock', count: 'livestock' },
      { key: 'documents', label: 'Documentos', Icon: Paperclip, feature: 'documents', count: 'documents' },
    ],
  },
];

export const FOOTER: NavItem[] = [
  { key: 'reminders', label: 'Recordatorios', Icon: Clock, count: 'reminders' },
  { key: 'account', label: 'Mi cuenta', Icon: User },
];

/**
 * The four mobile destinations. The old bar put THIRTEEN tabs in
 * `justify-around` on a 56px-tall bar — on a 390px screen that is 30px per tab,
 * well under the 44px minimum touch target. Everything not here lives one tap
 * away in the "Más" sheet, grouped exactly like the sidebar.
 */
export const MORE_TAB = { key: 'more' as const, label: 'Más', Icon: MoreHorizontal };

export const BOTTOM_TABS: NavItem[] = [
  PRIMARY,
  { key: 'fields', label: 'Lotes', Icon: Map },
  { key: 'expenses', label: 'Gastos', Icon: Wallet, feature: 'expenses' },
];

/** Everything the bottom bar does not show, for the "Más" sheet. */
export function sheetGroups(features: string[]): NavGroup[] {
  const inBar = new Set(BOTTOM_TABS.map(t => t.key));
  const groups = GROUPS.map(g => ({
    ...g,
    items: g.items.filter(i => !inBar.has(i.key) && visible(i, features)),
  })).filter(g => g.items.length > 0);
  return [...groups, { id: 'cuenta', label: 'Cuenta', items: FOOTER.filter(i => visible(i, features)) }];
}

export function visible(item: NavItem, features: string[]): boolean {
  return !item.feature || features.includes(item.feature);
}
