import type { ApprovalAction, ApprovalPage } from '../../lib/types';

/** What each approval screen gets from the page that loaded the link. */
export interface ApprovalProps {
  readonly view: ApprovalPage;
  readonly act: (action: ApprovalAction) => void;
  readonly busy: ApprovalAction | null;
  readonly error: string | null;
  readonly onExpire: () => void;
}
