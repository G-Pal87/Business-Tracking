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
  mortgage:    { label: 'Mortgage',    icon: 'M', color: '#6366f1' },
  maintenance: { label: 'Maintenance', icon: 'T', color: '#10b981' },
  renovation:  { label: 'Renovation',  icon: 'R', color: '#f59e0b' },
  insurance:   { label: 'Insurance',   icon: 'I', color: '#3b82f6' },
  tax:         { label: 'Tax',         icon: 'X', color: '#ef4444' },
  utilities:   { label: 'Utilities',   icon: 'U', color: '#8b5cf6' },
  management:  { label: 'Management',  icon: 'P', color: '#14b8a6' },
  cleaning:    { label: 'Cleaning',    icon: 'C', color: '#ec4899' },
  electricity: { label: 'Electricity', icon: 'E', color: '#f59e0b' },
  water:       { label: 'Water',       icon: 'W', color: '#06b6d4' },
  inventory:   { label: 'Inventory',   icon: 'B', color: '#84cc16' },
  other:       { label: 'Other',       icon: 'O', color: '#8b93b0' }
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
  vacant:     { label: 'Vacant',     css: 'vacant' }
};

export const OWNERS = {
  you:  'You',
  rita: 'Rita',
  both: 'Both'
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
  EUR: '\u20ac',
  HUF: 'Ft'
};
