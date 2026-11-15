import { Navigate, useParams } from 'react-router';
import type { User } from '../lib/types';
import { AgentStep } from './setup/AgentStep';
import { PasskeyStep } from './setup/PasskeyStep';
import { PhoneStep } from './setup/PhoneStep';

interface Props {
  readonly user: User;
  readonly onUser: (user: User) => void;
}

/** Steps 2-4 of setup; step 1 (the account) is the sign-up screen. */
export function SetupPage({ user, onUser }: Props) {
  const { step } = useParams();
  switch (step) {
    case 'passkey':
      return <PasskeyStep user={user} onUser={onUser} />;
    case 'phone':
      return <PhoneStep user={user} onUser={onUser} />;
    case 'agent':
      return <AgentStep user={user} onUser={onUser} />;
    default:
      return <Navigate to="/setup" replace />;
  }
}
