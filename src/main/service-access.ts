import type { AppAuthState } from '../shared/service-auth';
import type { ServiceApiClient } from './service-api';

/** No cached authorization grants for protected IPC or media protocol requests. */
export class ServiceAccess {
  constructor(
    private readonly client: Pick<ServiceApiClient, 'getAuthState'>,
    private readonly changed: (state: AppAuthState) => void,
  ) {}
  async check(): Promise<AppAuthState> {
    const state = await this.client.getAuthState();
    this.changed(state);
    return state;
  }
  async allowed(): Promise<boolean> {
    const state = await this.check();
    return state.status === 'authenticated' && !state.mustChangePassword;
  }
  async require(): Promise<void> {
    if (!(await this.allowed())) throw new Error('로그인 및 서비스 연결을 확인해 주세요.');
  }
}
