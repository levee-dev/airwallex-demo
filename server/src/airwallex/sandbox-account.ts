/**
 * The sandbox identity for an end user's own connected account.
 *
 * A sandbox account has no real person behind it, so Acme sends a fixed fictional US identity with
 * the user's own name and email, then simulates onboarding. A production platform collects real KYC
 * here instead and waits for Airwallex to activate the account.
 *
 * The account is a sole proprietor business owned by that person: the card program agent cards are
 * issued on is a commercial one, which Airwallex does not allow on individual accounts.
 */

export interface EndUserIdentity {
  readonly email: string;
  /** Acme's stable reference for the user, sent as the account `identifier`. */
  readonly identifier: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** Business fields Airwallex requires before a sole proprietor account can be submitted. */
export const SANDBOX_BUSINESS_FIELDS = {
  industry_category_code: 'ICCV3_0000XX',
  url: 'https://example.com',
} as const;

const ADDRESS = {
  address_line1: '1 Market St',
  suburb: 'San Francisco',
  state: 'CA',
  postcode: '94105',
  country_code: 'US',
} as const;

/** Airwallex accepts only letters, apostrophes, hyphens and spaces in a person's name. */
export function airwallexName(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z' -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return /[A-Za-z]/.test(cleaned) ? cleaned : fallback;
}

export function sandboxAccountBody(identity: EndUserIdentity) {
  const firstName = airwallexName(identity.firstName, 'Acme');
  const lastName = airwallexName(identity.lastName, 'User');
  return {
    account_details: {
      legal_entity_type: 'BUSINESS',
      business_details: {
        business_name: `${firstName} ${lastName}`,
        business_structure: 'SOLE_PROPRIETOR',
        ...SANDBOX_BUSINESS_FIELDS,
        description_of_goods_or_services: 'Personal purchases made by an AI agent',
        operating_country: ['US'],
        registration_address: ADDRESS,
        business_address: ADDRESS,
        business_identifiers: [{ country_code: 'US', number: '123456789', type: 'SSN' }],
        account_usage: {
          product_reference: ['CREATE_CARDS'],
          estimated_monthly_revenue: { amount: '1000', currency: 'USD' },
        },
      },
      business_person_details: [
        {
          first_name: firstName,
          last_name: lastName,
          date_of_birth: '1980-01-01',
          nationality: 'US',
          email: identity.email,
          residential_address: ADDRESS,
          roles: ['BENEFICIAL_OWNER', 'AUTHORISED_PERSON', 'DIRECTOR'],
          ownership_percentage: 100,
          identifications: {
            primary: {
              identification_type: 'PASSPORT',
              issuing_country_code: 'US',
              passport: { number: '123456789', effective_at: '2020-01-01', expire_at: '2035-01-01' },
            },
          },
        },
      ],
    },
    customer_agreements: { agreed_to_data_usage: true, agreed_to_terms_and_conditions: true },
    identifier: identity.identifier,
    primary_contact: { email: identity.email },
  };
}
