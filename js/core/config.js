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
  insurance:        { label: 'Private Insurance',  icon: 'I',  color: '#3b82f6' },
  tax:              { label: 'Tax',                icon: 'X',  color: '#ef4444' },
  utilities:        { label: 'Utilities',          icon: 'U',  color: '#8b5cf6' },
  management:       { label: 'Management',         icon: 'P',  color: '#14b8a6' },
  cleaning:         { label: 'Cleaning',           icon: 'C',  color: '#ec4899' },
  electricity:      { label: 'Electricity',        icon: 'E',  color: '#f59e0b' },
  water:            { label: 'Water',              icon: 'W',  color: '#06b6d4' },
  inventory:        { label: 'Inventory',          icon: 'B',  color: '#84cc16' },
  vat:              { label: 'VAT',                icon: 'V',  color: '#f97316' },
  reimbursement:         { label: 'Reimbursement',          icon: 'Rb', color: '#a855f7' },
  str_fee:               { label: 'STR Fee',                icon: 'SF', color: '#fb923c' },
  owner_rent:            { label: 'Owner Rent',             icon: 'OR', color: '#2dd4bf' },
  reimbursement_giorgos: { label: 'Giorgos Reimbursement',  icon: 'GRb',color: '#818cf8' },
  reimbursement_rita:    { label: 'Rita Reimbursement',     icon: 'RRb',color: '#a78bfa' },
  salary_giorgos:        { label: 'Giorgos Salary',         icon: 'GS', color: '#818cf8' },
  salary_rita:           { label: 'Rita Salary',            icon: 'RS', color: '#a78bfa' },
  salary_diana:          { label: 'Diana Salary',           icon: 'DS', color: '#c4b5fd' },
  gesy_giorgos:          { label: 'Giorgos GESY',           icon: 'GG', color: '#34d399' },
  gesy_rita:             { label: 'Rita GESY',              icon: 'GR', color: '#6ee7b7' },
  gesy_diana:            { label: 'Diana GESY',             icon: 'GD', color: '#a7f3d0' },
  eurolife_giorgos:      { label: 'Giorgos EUROLIFE',       icon: 'GE', color: '#60a5fa' },
  eurolife_rita:         { label: 'Rita EUROLIFE',          icon: 'RE', color: '#93c5fd' },
  other:                 { label: 'Other',                  icon: 'O',  color: '#8b93b0' }
};

// Groups define how categories are displayed in the expense form dropdown (optgroups).
// Each group's subtypes are hidden from the flat list and shown under the group header.
export const EXPENSE_CATEGORY_GROUPS = {
  salary:            { label: 'Salary',            subtypes: ['salary_giorgos', 'salary_rita', 'salary_diana'] },
  public_insurance:  { label: 'Public Insurance',  subtypes: ['gesy_giorgos', 'gesy_rita', 'gesy_diana'] },
  private_insurance: { label: 'Private Insurance', subtypes: ['insurance', 'eurolife_giorgos', 'eurolife_rita'] },
  director_payments: { label: 'Director Payments', subtypes: ['owner_rent', 'reimbursement_giorgos', 'reimbursement_rita'] }
};

export const PROPERTY_CHANNELS = {
  company:  'Company (business income)',
  personal: 'Personal (direct income)'
};

// Maps person key → their personal-income expense categories
export const PERSONAL_EXPENSE_CATS = {
  you:  { salary: 'salary_giorgos', gesy: 'gesy_giorgos', reimb: 'reimbursement_giorgos' },
  rita: { salary: 'salary_rita',    gesy: 'gesy_rita',    reimb: 'reimbursement_rita'    }
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
