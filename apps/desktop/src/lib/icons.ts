/**
 * Hand-rolled 24×24 stroke icon set (no dependency). Rendered by Icon.svelte
 * with stroke=currentColor, stroke-width 1.75, round caps/joins.
 */

export const icons = {
  dashboard:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  transactions:
    '<path d="M4 7h13"/><path d="m14 3.5 3.5 3.5L14 10.5"/><path d="M20 17H7"/><path d="m10 13.5L6.5 17l3.5 3.5"/>',
  receipt:
    '<path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6L8.4 20.5 6 18.9z"/><path d="M9 8h6"/><path d="M9 11.5h6"/><path d="M9 15h3.5"/>',
  budgets:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.75" fill="currentColor"/>',
  ledger:
    '<path d="M12 5.5C10 4 7.5 3.5 4.5 3.7v14.8c3-.2 5.5.3 7.5 1.8 2-1.5 4.5-2 7.5-1.8V3.7c-3-.2-5.5.3-7.5 1.8z"/><path d="M12 5.5v14.8"/>',
  reconcile:
    '<path d="M8 6.5h9"/><path d="m14.5 3.5 3 3-3 3"/><path d="M16 17.5H7"/><path d="m9.5 14.5-3 3 3 3"/><circle cx="4.5" cy="6.5" r="1.75"/><circle cx="19.5" cy="17.5" r="1.75"/>',
  reports:
    '<path d="M4 20h16"/><path d="M6.5 20v-6"/><path d="M11 20V9"/><path d="M15.5 20v-9"/><path d="M20 20V5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  search:
    '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload:
    '<path d="M12 15.5V4.5"/><path d="m7.5 8.5 4.5-4 4.5 4"/><path d="M4.5 19.5h15"/>',
  download:
    '<path d="M12 4.5v11"/><path d="m7.5 11.5 4.5 4 4.5-4"/><path d="M4.5 19.5h15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  "check-circle":
    '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
  "alert-circle":
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5"/><path d="M12 15.8v.2"/>',
  "arrow-right": '<path d="M4.5 12h15"/><path d="m14 6.5 5.5 5.5-5.5 5.5"/>',
  "chevron-down": '<path d="m6 9.5 6 6 6-6"/>',
  inbox:
    '<path d="M4 4.5h16v15H4z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  sparkle:
    '<path d="M12 3.5 13.8 10 20.5 12 13.8 14 12 20.5 10.2 14 3.5 12 10.2 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  moon: '<path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5z"/>',
  monitor:
    '<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/>',
  bank: '<path d="M3.5 9.5 12 4l8.5 5.5"/><path d="M5.5 10v7M10 10v7M14 10v7M18.5 10v7"/><path d="M3.5 20h17"/>',
  wallet:
    '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v2.5"/><path d="M4 7.5V17a2.5 2.5 0 0 0 2.5 2.5H20v-10H6.5A2.5 2.5 0 0 1 4 7.5z"/><path d="M16 14.5h.5"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M6.5 14.5h4"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.5 11.5 8-8"/><path d="m16 7 2.5 2.5M18.5 4.5 21 7"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  shield:
    '<path d="M12 3.5c2.7 1.4 5.3 2 8 2 0 7-2.7 12-8 15-5.3-3-8-8-8-15 2.7 0 5.3-.6 8-2z"/><path d="m9 11.8 2.2 2.2 4-4.2"/>',
  package:
    '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 2.8V6M16 2.8V6"/>',
  "chevron-left": '<path d="m14.5 6-6 6 6 6"/>',
  "chevron-right": '<path d="m9.5 6 6 6-6 6"/>',
  pencil:
    '<path d="M4 20h4l11-11a2.1 2.1 0 0 0 0-3l-1-1a2.1 2.1 0 0 0-3 0L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash:
    '<path d="M4.5 6.5h15"/><path d="M8 6.5V4.8A1.3 1.3 0 0 1 9.3 3.5h5.4A1.3 1.3 0 0 1 16 4.8v1.7"/><path d="M6.5 6.5 7.4 20.5h9.2l.9-14"/><path d="M10 10.5v6M14 10.5v6"/>',
  refresh:
    '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V8h-4.5"/>',
  minus: '<path d="M5 12h14"/>',
  folder:
    '<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  scan: '<path d="M3.5 8V5.5A2 2 0 0 1 5.5 3.5H8M16 3.5h2.5a2 2 0 0 1 2 2V8M20.5 16v2.5a2 2 0 0 1-2 2H16M8 20.5H5.5a2 2 0 0 1-2-2V16"/><path d="M3.5 12h17"/>',
} as const;

export type IconName = keyof typeof icons;
