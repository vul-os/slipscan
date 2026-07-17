/**
 * Global search hand-off: the sidebar search box writes the query here and
 * navigates to Transactions, which picks it up as its filter.
 */

export const globalSearch = $state({ query: "" });
