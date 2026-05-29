// Configuration constants
export const STREAMS = {
  short_term_rental: { label: 'Short-term Rentals', short: 'Short-term', css: 'short', color: '#8b5cf6' },
  long_term_rental:  { label: 'Long-term Rentals',  short: 'Long-term',  css: 'long',  color: '#14b8a6' },
  customer_success:  { label: 'Customer Success',   short: 'CS',         css: 'cs',    color: '#3b82f6' },
  marketing_services:{ label: 'Marketing Services', short: 'Marketing',  css: 'mkt',   color: '#ec4899' }
};

export const STREAM_LIST = Object.keys(STREAMS);
export const PROPERTY_STREAMS = ['short_term_rental', 'long_term_rental'];
export const SERVICE_STREAMS = ['customer_success', 'marketing_services'];

export const EXPENSE_CATEGORIES = {
  mortgage:         { label: 'Mortgage',          icon: 'M',  color: '#6366f1' },
  maintenance:      { label: 'Maintenance',        icon: 'T',  color: '#10b981' },
  renovation:       { label: 'Renovation',         icon: 'R',  color: '#f59e0b' },
  tax:              { label: 'Tax',                icon: 'X',  color: '#ef4444' },
  utilities:        { label: 'Utilities',          icon: 'U',  color: '#8b5cf6' },
  management:       { label: 'Management',         icon: 'P',  color: '#14b8a6' },
  cleaning:         { label: 'Cleaning',           icon: 'C',  color: '#ec4899' },
  electricity:      { label: 'Electricity',        icon: 'E',  color: '#f59e0b' },
  water:            { label: 'Water',              icon: 'W',  color: '#06b6d4' },
  inventory:        { label: 'Inventory',          icon: 'B',  color: '#84cc16' },
  vat:              { label: 'VAT',                icon: 'V',  color: '#f97316' },
  reimbursement:         { label: 'Reimbursement',          icon: 'Rb', color: '#a855f7' },
  salary:               { label: 'Salary',                icon: 'S',  color: '#818cf8' },
  social_contributions: { label: 'Social Contributions',  icon: 'SC', color: '#34d399' },
  eurolife:             { label: 'Eurolife',              icon: 'EL', color: '#60a5fa' },
  str_fee:               { label: 'STR Fee',                icon: 'SF', color: '#fb923c' },
  owner_rent:            { label: 'Owner Rent',             icon: 'OR', color: '#2dd4bf' },
  other:                 { label: 'Other',                  icon: 'O',  color: '#8b93b0' }
};

// Groups define how categories are displayed in the expense form dropdown (optgroups).
// Each group's subtypes are hidden from the flat list and shown under the group header.
export const EXPENSE_CATEGORY_GROUPS = {};

export const PROPERTY_CHANNELS = {
  company:  'Company (business income)',
  personal: 'Personal (direct income)'
};

// ---- Classification model (OpEx/CapEx, costCategory, recurrence) ----

export const ACCOUNTING_TYPES = {
  opex:  { label: 'OpEx (Operating)' },
  capex: { label: 'CapEx (Capital)' }
};

export const COST_CATEGORIES = {
  renovation:          { label: 'Renovation',         color: '#f59e0b' },
  maintenance:         { label: 'Maintenance',         color: '#10b981' },
  utilities:           { label: 'Utilities',           color: '#8b5cf6' },
  cleaning:            { label: 'Cleaning',            color: '#ec4899' },
  insurance:           { label: 'Insurance',           color: '#3b82f6' },
  tax:                 { label: 'Tax',                 color: '#ef4444' },
  financing:           { label: 'Financing',           color: '#6366f1' },
  software:            { label: 'Software',            color: '#06b6d4' },
  legal:               { label: 'Legal',               color: '#84cc16' },
  accounting:          { label: 'Accounting',          color: '#14b8a6' },
  property_management: { label: 'Property Mgmt',       color: '#f97316' },
  payroll:             { label: 'Payroll',              color: '#818cf8' },
  inventory:           { label: 'Inventory',            color: '#84cc16' },
  other:               { label: 'Other',               color: '#8b93b0' }
};

export const RECURRENCE_TYPES = {
  recurring: { label: 'Recurring' },
  one_off:   { label: 'One-off' }
};

export const VENDOR_ROLES = {
  cleaner:     { label: 'Cleaner',     color: '#ec4899' },
  plumber:     { label: 'Plumber',     color: '#3b82f6' },
  electrician: { label: 'Electrician', color: '#f59e0b' },
  handyman:    { label: 'Handyman',    color: '#10b981' },
  gardener:    { label: 'Gardener',    color: '#14b8a6' },
  other:       { label: 'Other',       color: '#8b93b0' }
};

export const PROPERTY_TYPES = {
  short_term: 'Short-term (Airbnb)',
  long_term:  'Long-term (Lease)'
};

export const PROPERTY_STATUSES = {
  active:     { label: 'Active',     css: 'active' },
  renovation: { label: 'Renovation', css: 'renovation' },
  vacant:     { label: 'Vacant',     css: 'vacant' },
  sold:       { label: 'Sold',       css: 'sold' }
};

export const OWNERS = {
  you:  'Giorgos',
  rita: 'Rita',
  both: 'Both'
};

export const PERSON_ROLES = {
  employee:  { label: 'Employee',  color: '#10b981' },
  director:  { label: 'Director',  color: '#3b82f6' },
  partner:   { label: 'Partner',   color: '#8b5cf6' },
  assistant: { label: 'Assistant', color: '#f59e0b' }
};

export const DIVIDEND_METHODS = {
  fixed_rate:        { label: 'Fixed Rate (% of shares)' },
  acquired_revenue:  { label: 'Acquired Revenue (based on individual revenue)' }
};

export const CURRENCIES = ['EUR', 'HUF'];
export const MASTER_CURRENCY = 'EUR';

export const SERVICE_UNITS = {
  day:     'day(s)',
  hour:    'hour(s)',
  month:   'month(s)',
  project: 'project'
};

export const INVOICE_STATUSES = {
  draft:    { label: 'Draft',    css: 'info' },
  sent:     { label: 'Sent',     css: 'warning' },
  paid:     { label: 'Paid',     css: 'success' },
  overdue:  { label: 'Overdue',  css: 'danger' }
};

export const PAYMENT_STATUSES = {
  paid:    { label: 'Paid',    css: 'success' },
  pending: { label: 'Pending', css: 'warning' },
  overdue: { label: 'Overdue', css: 'danger' }
};

export const CURRENCY_SYMBOLS = {
  EUR: '€',
  HUF: 'Ft'
};

// Default assumptions for estimating the guest-facing Airbnb price.
// The host CSV only contains host-side figures (payout / gross), so the guest
// total is estimated: guestTotal = gross × (1 + guestFee% + tax%).
// Both are overridable in Settings → STR / Airbnb (state.db.settings.airbnb).
export const AIRBNB_GUEST_FEE_PCT = 14; // typical Airbnb guest service fee
export const AIRBNB_TAX_PCT = 0;        // occupancy / tourist tax, off by default
