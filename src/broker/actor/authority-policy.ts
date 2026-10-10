import type {
  AdministrationAuthorizationInput,
  AuthorizationInput,
} from "solid-objects";

const brokerOperations = ["adopt", "beginEpoch", "execute", "recover"];

export interface BrokerAuthorization {
  readonly authorizeMessage: (input: AuthorizationInput) => boolean;
  readonly authorizeQuery: (input: AuthorizationInput) => boolean;
  readonly authorizeAdministration: (
    input: AdministrationAuthorizationInput,
  ) => boolean;
  readonly authorizeDestroy: (input: object) => boolean;
  readonly authorizeSubscription: (input: object) => boolean;
}

export function brokerAuthorization(broker: object): BrokerAuthorization {
  return {
    authorizeMessage: (input) =>
      input.authorizationContext === broker &&
      brokerOperations.includes(input.operation),
    authorizeQuery: () => false,
    authorizeAdministration: (input) => input.authorizationContext === broker,
    authorizeDestroy: () => false,
    authorizeSubscription: () => false,
  };
}
