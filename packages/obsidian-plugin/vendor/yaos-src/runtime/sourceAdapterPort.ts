import type {
	CredentialRecord,
	SourceCoreStatus,
	SourceNeutralSyncCore,
	UserInteractionPort,
} from "@mdevolved/yaos-core";

export interface SourceAdapterBoundary {
	core: SourceNeutralSyncCore;
	interaction: UserInteractionPort;
	currentCredential(): Promise<CredentialRecord | null>;
}

export interface SourceAdapterOptions {
	clientVersion: string;
	syncSchemaVersion: number;
	getConnection(): { sourceId: string; token: string };
	readState<T>(key: string): Promise<T | undefined>;
	writeState<T>(key: string, value: T): Promise<void>;
	removeState(key: string): Promise<void>;
	onStatus(status: SourceCoreStatus): void;
	getMaxWriteBytes(): number;
}
