/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../shared/extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import * as localizedText from '../shared/localizedText'
import * as uuid from 'uuid' // TODO: use crypto.randomUUID when C9 is on node16
import { Credentials } from '@aws-sdk/types'
import { SsoAccessTokenProvider } from './sso/ssoAccessTokenProvider'
import { codicon, getIcon } from '../shared/icons'
import { Commands } from '../shared/vscode/commands2'
import { createQuickPick, DataQuickPickItem, showQuickPick } from '../shared/ui/pickerPrompter'
import { isValidResponse } from '../shared/wizards/wizard'
import { CancellationError, Timeout } from '../shared/utilities/timeoutUtils'
import { errorCode, formatError, isAwsError, isNetworkError, ToolkitError, UnknownError } from '../shared/errors'
import { getCache } from './sso/cache'
import { createFactoryFunction, isNonNullable, Mutable } from '../shared/utilities/tsUtils'
import { builderIdStartUrl, SsoToken } from './sso/model'
import { SsoClient } from './sso/clients'
import { getLogger } from '../shared/logger'
import { CredentialsProviderManager } from './providers/credentialsProviderManager'
import { asString, CredentialsId, CredentialsProvider, fromString } from './providers/credentials'
import { once } from '../shared/utilities/functionUtils'
import { getResourceFromTreeNode } from '../shared/treeview/utils'
import { Instance } from '../shared/utilities/typeConstructors'
import { TreeNode } from '../shared/treeview/resourceTreeDataProvider'
import { createInputBox } from '../shared/ui/inputPrompter'
import { CredentialsSettings } from './credentials/utils'
import { telemetry } from '../shared/telemetry/telemetry'
import { createCommonButtons, createExitButton, createHelpButton, createRefreshButton } from '../shared/ui/buttons'
import { getIdeProperties, isCloud9 } from '../shared/extensionUtilities'
import { getCodeCatalystDevEnvId } from '../shared/vscode/env'
import { authHelpUrl } from '../shared/constants'
import { getDependentAuths } from './secondaryAuth'
import { DevSettings } from '../shared/settings'
import { partition } from '../shared/utilities/mementos'
import { createRegionPrompter } from '../shared/ui/common/region'
import { SsoCredentialsProvider } from './providers/ssoCredentialsProvider'
import { AsyncCollection, toCollection } from '../shared/utilities/asyncCollection'
import { join, toStream } from '../shared/utilities/collectionUtils'
import { getConfigFilename } from './credentials/sharedCredentialsFile'
import { saveProfileToCredentials } from './credentials/sharedCredentials'
import { SectionName, SharedCredentialsKeys, StaticProfile, StaticProfileKeyErrorMessage } from './credentials/types'
import { throwOnInvalidCredentials } from './credentials/validation'
import { TempCredentialProvider } from './providers/tempCredentialsProvider'
import {
    Connection,
    ConnectionManager,
    IamConnection,
    IamProfile,
    LinkedIamProfile,
    Profile,
    ProfileMetadata,
    ProfileStore,
    SsoConnection,
    SsoProfile,
    StatefulConnection,
    StoredProfile,
    codecatalystScopes,
    createBuilderIdProfile,
    createSsoProfile,
    defaultSsoRegion,
    hasScopes,
    loadIamProfilesIntoStore,
    loadLinkedProfilesIntoStore,
    ssoAccountAccessScopes,
} from './connection'

interface AuthService {
    /**
     * Lists all connections known to the Toolkit.
     */
    listConnections(): Promise<Connection[]>

    /**
     * Creates a new connection using a profile.
     *
     * This will fail if the profile does not result in a valid connection.
     */
    createConnection(profile: Profile): Promise<Connection>

    /**
     * Deletes the connection, removing all associated stateful resources.
     */
    deleteConnection(connection: Pick<Connection, 'id'>): void

    /**
     * Retrieves a connection from an id if it exists.
     *
     * A connection id can be persisted and then later used to restore a previous connection.
     * The caller is expected to handle the case where the connection no longer exists.
     */
    getConnection(connection: Pick<Connection, 'id'>): Promise<Connection | undefined>

    /**
     * Replaces the profile for a connection with a new one.
     *
     * This will invalidate the connection, potentially requiring a re-authentication.
     *
     * **IAM connections are not implemented**
     */
    updateConnection(connection: Pick<Connection, 'id'>, profile: Profile): Promise<Connection>
}

function keyedDebounce<T, U extends any[], K extends string = string>(
    fn: (key: K, ...args: U) => Promise<T>
): typeof fn {
    const pending = new Map<K, Promise<T>>()

    return (key, ...args) => {
        if (pending.has(key)) {
            return pending.get(key)!
        }

        const promise = fn(key, ...args).finally(() => pending.delete(key))
        pending.set(key, promise)

        return promise
    }
}

interface ConnectionStateChangeEvent {
    readonly id: Connection['id']
    readonly state: ProfileMetadata['connectionState']
}

export type AuthType = Auth

export class Auth implements AuthService, ConnectionManager {
    readonly #ssoCache = getCache()
    readonly #validationErrors = new Map<Connection['id'], Error>()
    readonly #invalidCredentialsTimeouts = new Map<Connection['id'], Timeout>()
    readonly #onDidChangeActiveConnection = new vscode.EventEmitter<StatefulConnection | undefined>()
    readonly #onDidChangeConnectionState = new vscode.EventEmitter<ConnectionStateChangeEvent>()
    readonly #onDidUpdateConnection = new vscode.EventEmitter<StatefulConnection>()
    public readonly onDidChangeActiveConnection = this.#onDidChangeActiveConnection.event
    public readonly onDidChangeConnectionState = this.#onDidChangeConnectionState.event
    public readonly onDidUpdateConnection = this.#onDidUpdateConnection.event

    public constructor(
        private readonly store: ProfileStore,
        private readonly iamProfileProvider = CredentialsProviderManager.getInstance(),
        private readonly createSsoClient = SsoClient.create.bind(SsoClient),
        private readonly createTokenProvider = createFactoryFunction(SsoAccessTokenProvider)
    ) {}

    #activeConnection: Mutable<StatefulConnection> | undefined
    public get activeConnection(): StatefulConnection | undefined {
        return this.#activeConnection
    }

    public get hasConnections() {
        return this.store.listProfiles().length !== 0
    }

    public async restorePreviousSession(): Promise<Connection | undefined> {
        const id = this.store.getCurrentProfileId()
        if (id === undefined) {
            return
        }

        try {
            return await this.useConnection({ id })
        } catch (err) {
            getLogger().warn(`auth: failed to restore previous session: %s`, err)
        }
    }

    public async reauthenticate({ id }: Pick<SsoConnection, 'id'>): Promise<SsoConnection>
    public async reauthenticate({ id }: Pick<IamConnection, 'id'>): Promise<IamConnection>
    public async reauthenticate({ id }: Pick<Connection, 'id'>): Promise<Connection> {
        const profile = this.store.getProfileOrThrow(id)
        if (profile.type === 'sso') {
            const provider = this.getTokenProvider(id, profile)
            await this.authenticate(id, () => provider.createToken())

            return this.getSsoConnection(id, profile)
        } else {
            const provider = await this.getCredentialsProvider(id, profile)
            await this.authenticate(id, () => this.createCachedCredentials(provider))

            return this.getIamConnection(id, profile)
        }
    }

    public async useConnection({ id }: Pick<SsoConnection, 'id'>): Promise<SsoConnection>
    public async useConnection({ id }: Pick<IamConnection, 'id'>): Promise<IamConnection>
    public async useConnection({ id }: Pick<Connection, 'id'>): Promise<Connection> {
        const profile = this.store.getProfile(id)
        if (profile === undefined) {
            throw new Error(`Connection does not exist: ${id}`)
        }

        const validated = await this.validateConnection(id, profile)
        const conn =
            validated.type === 'sso' ? this.getSsoConnection(id, validated) : this.getIamConnection(id, validated)

        this.#activeConnection = conn
        this.#onDidChangeActiveConnection.fire(conn)
        await this.store.setCurrentProfileId(id)

        return conn
    }

    public async logout(): Promise<void> {
        if (this.activeConnection === undefined) {
            return
        }

        await this.store.setCurrentProfileId(undefined)
        await this.invalidateConnection(this.activeConnection.id)
        this.#activeConnection = undefined
        this.#onDidChangeActiveConnection.fire(undefined)
    }

    public async listConnections(): Promise<Connection[]> {
        await loadIamProfilesIntoStore(this.store, this.iamProfileProvider)

        const connections = await Promise.all(
            this.store.listProfiles().map(entry => this.getConnectionFromStoreEntry(entry))
        )

        return connections
    }

    /**
     * This method will gather all AWS accounts/roles that are associated with SSO connections.
     *
     * Use {@link Auth.listConnections} when you do not want to make extra API calls to the SSO service.
     */
    public listAndTraverseConnections(): AsyncCollection<Connection> {
        async function* load(this: Auth) {
            await loadIamProfilesIntoStore(this.store, this.iamProfileProvider)

            const stream = toStream(this.store.listProfiles().map(entry => this.getConnectionFromStoreEntry(entry)))

            const isLinkable = (
                entry: [string, StoredProfile<Profile>]
            ): entry is [string, StoredProfile<SsoProfile>] =>
                entry[1].type === 'sso' &&
                hasScopes(entry[1], ssoAccountAccessScopes) &&
                entry[1].metadata.connectionState === 'valid'

            const linked = this.store
                .listProfiles()
                .filter(isLinkable)
                .map(([id, profile]) =>
                    toCollection(() =>
                        loadLinkedProfilesIntoStore(
                            this.store,
                            id,
                            this.createSsoClient(profile.ssoRegion, this.getTokenProvider(id, profile))
                        )
                    )
                        .catch(err => {
                            getLogger().warn(`auth: failed to load linked profiles from "${id}": %s`, err)
                        })
                        .filter(isNonNullable)
                        .map(entry => this.getConnectionFromStoreEntry(entry))
                )

            yield* linked.reduce(join, stream)
        }

        return toCollection(load.bind(this))
    }

    public async createConnection(profile: SsoProfile): Promise<SsoConnection>
    public async createConnection(profile: Profile): Promise<Connection> {
        if (profile.type === 'iam') {
            throw new Error('Creating IAM connections is not supported')
        }

        const id = uuid.v4()
        const tokenProvider = this.getTokenProvider(id, {
            ...profile,
            metadata: { connectionState: 'unauthenticated' },
        })

        try {
            ;(await tokenProvider.getToken()) ?? (await tokenProvider.createToken())
            const storedProfile = await this.store.addProfile(id, profile)
            await this.updateConnectionState(id, 'valid')

            return this.getSsoConnection(id, storedProfile)
        } catch (err) {
            await this.store.deleteProfile(id)
            throw err
        }
    }

    public async deleteConnection(connection: Pick<Connection, 'id'>): Promise<void> {
        if (connection.id === this.#activeConnection?.id) {
            await this.logout()
        } else {
            await this.invalidateConnection(connection.id)
        }

        await this.store.deleteProfile(connection.id)
    }

    public async getConnection(connection: Pick<Connection, 'id'>): Promise<Connection | undefined> {
        const connections = await this.listConnections()

        return connections.find(c => c.id === connection.id)
    }

    public async updateConnection(connection: Pick<SsoConnection, 'id'>, profile: SsoProfile): Promise<SsoConnection>
    public async updateConnection(connection: Pick<Connection, 'id'>, profile: Profile): Promise<Connection> {
        if (profile.type === 'iam') {
            throw new Error('Updating IAM connections is not supported')
        }

        await this.invalidateConnection(connection.id, { skipGlobalLogout: true })

        const newProfile = await this.store.updateProfile(connection.id, profile)
        const updatedConn = this.getSsoConnection(connection.id, newProfile as StoredProfile<SsoProfile>)
        if (this.activeConnection?.id === updatedConn.id) {
            this.#activeConnection = updatedConn
            this.#onDidChangeActiveConnection.fire(this.#activeConnection)
        }
        this.#onDidUpdateConnection.fire(updatedConn)

        return updatedConn
    }

    public getConnectionState(connection: Pick<Connection, 'id'>): StatefulConnection['state'] | undefined {
        return this.store.getProfile(connection.id)?.metadata.connectionState
    }

    public getInvalidationReason(connection: Pick<Connection, 'id'>): Error | undefined {
        return this.#validationErrors.get(connection.id)
    }

    /**
     * Authenticates the given data and returns error info if it fails.
     *
     * @returns undefined if authentication succeeds, otherwise object with error info
     */
    public async authenticateData(data: StaticProfile): Promise<StaticProfileKeyErrorMessage | undefined> {
        const tempId = await this.addTempCredential(data)
        const tempIdString = asString(tempId)
        try {
            await this.reauthenticate({ id: tempIdString })
        } catch (e) {
            if (isAwsError(e)) {
                if (e.code === 'InvalidClientTokenId') {
                    return { key: SharedCredentialsKeys.AWS_ACCESS_KEY_ID, error: 'Invalid access key' }
                } else if (e.code === 'SignatureDoesNotMatch') {
                    return { key: SharedCredentialsKeys.AWS_SECRET_ACCESS_KEY, error: 'Invalid secret key' }
                }
            }
            throw e
        } finally {
            await this.removeTempCredential(tempId)
        }
        return undefined
    }

    private async addTempCredential(data: StaticProfile): Promise<CredentialsId> {
        const tempProvider = new TempCredentialProvider(data)
        this.iamProfileProvider.addProvider(tempProvider)
        await this.thrownOnConn(tempProvider.getCredentialsId(), 'not-exists')
        return tempProvider.getCredentialsId()
    }
    private async removeTempCredential(id: CredentialsId) {
        this.iamProfileProvider.removeProvider(id)
        await this.thrownOnConn(id, 'exists')
    }

    private async thrownOnConn(id: CredentialsId, throwOn: 'exists' | 'not-exists') {
        const idAsString = asString(id)
        const conns = await this.listConnections() // triggers loading of profile in to store
        const connExists = conns.some(conn => conn.id === idAsString)

        if (throwOn === 'exists' && connExists) {
            throw new ToolkitError(`Conn should not exist: ${idAsString}`)
        } else if (throwOn === 'not-exists' && !connExists) {
            throw new ToolkitError(`Conn should exist: ${idAsString}`)
        }
    }

    /**
     * Attempts to remove all auth state related to the connection.
     *
     * For SSO, this involves an API call to clear server-side state. The call happens
     * before the local token(s) are cleared as they are needed in the request.
     */
    private async invalidateConnection(id: Connection['id'], opt?: { skipGlobalLogout?: boolean }) {
        const profile = this.store.getProfileOrThrow(id)

        if (profile.type === 'sso') {
            const provider = this.getTokenProvider(id, profile)
            const client = this.createSsoClient(profile.ssoRegion, provider)

            if (opt?.skipGlobalLogout !== true) {
                await client.logout().catch(err => {
                    const name = profile.metadata.label ?? id
                    getLogger().warn(`auth: failed to logout of connection "${name}": %s`, err)
                })
            }

            // XXX: never drop tokens in a dev environment
            if (getCodeCatalystDevEnvId() === undefined) {
                await provider.invalidate()
            }
        } else if (profile.type === 'iam') {
            globals.loginManager.store.invalidateCredentials(fromString(id))
        }

        await this.updateConnectionState(id, 'invalid')
    }

    private async updateConnectionState(id: Connection['id'], connectionState: ProfileMetadata['connectionState']) {
        const oldProfile = this.store.getProfileOrThrow(id)
        if (oldProfile.metadata.connectionState === connectionState) {
            return oldProfile
        }

        const profile = await this.store.updateMetadata(id, { connectionState })
        if (connectionState !== 'invalid') {
            this.#validationErrors.delete(id)
            this.#invalidCredentialsTimeouts.get(id)?.dispose()
        }

        if (this.#activeConnection?.id === id) {
            this.#activeConnection.state = connectionState
            this.#onDidChangeActiveConnection.fire(this.#activeConnection)
        }
        this.#onDidChangeConnectionState.fire({ id, state: connectionState })

        return profile
    }

    private async validateConnection<T extends Profile>(id: Connection['id'], profile: StoredProfile<T>) {
        const runCheck = async () => {
            if (profile.type === 'sso') {
                const provider = this.getTokenProvider(id, profile)
                if ((await provider.getToken()) === undefined) {
                    return this.updateConnectionState(id, 'invalid')
                } else {
                    return this.updateConnectionState(id, 'valid')
                }
            } else {
                if (profile.subtype === 'linked') {
                    const sourceProfile = this.store.getProfileOrThrow(profile.ssoSession)
                    if (sourceProfile.type !== 'sso') {
                        throw new Error('Linked profiles must use an SSO connection')
                    }
                    const validatedSource = await this.validateConnection(profile.ssoSession, sourceProfile)
                    if (validatedSource?.metadata.connectionState !== 'valid') {
                        return this.updateConnectionState(id, 'invalid')
                    }
                }

                const provider = await this.getCredentialsProvider(id, profile)
                const credentials = await this.getCachedCredentials(provider)
                if (credentials !== undefined) {
                    return this.updateConnectionState(id, 'valid')
                } else if ((await provider.canAutoConnect()) === true) {
                    await this.authenticate(id, () => this.createCachedCredentials(provider))

                    return this.store.getProfileOrThrow(id)
                } else {
                    return this.updateConnectionState(id, 'invalid')
                }
            }
        }

        return runCheck().catch(err => this.handleValidationError(id, err))
    }

    private async handleValidationError(id: Connection['id'], err: unknown) {
        this.#validationErrors.set(id, UnknownError.cast(err))

        return this.updateConnectionState(id, 'invalid')
    }

    private async getConnectionFromStoreEntry([id, profile]: readonly [Connection['id'], StoredProfile<Profile>]) {
        if (profile.type === 'sso') {
            return this.getSsoConnection(id, profile)
        } else {
            return this.getIamConnection(id, profile)
        }
    }

    private async getCredentialsProvider(id: Connection['id'], profile: StoredProfile<IamProfile>) {
        if (profile.subtype === 'unknown' || !profile.subtype) {
            const provider = await this.iamProfileProvider.getCredentialsProvider(fromString(id))
            if (provider === undefined) {
                throw new Error(`Credentials provider "${id}" not found`)
            }

            return provider
        }

        return this.getSsoLinkedCredentialsProvider(id, profile)
    }

    private getSsoLinkedCredentialsProvider(id: Connection['id'], profile: LinkedIamProfile) {
        const sourceProfile = this.store.getProfile(profile.ssoSession)
        if (sourceProfile === undefined) {
            throw new Error(`Source profile for "${id}" no longer exists`)
        }
        if (sourceProfile.type !== 'sso') {
            throw new Error(`Source profile for "${id}" is not an SSO profile`)
        }

        const tokenProvider = this.getTokenProvider(profile.ssoSession, sourceProfile)
        const credentialsProvider = new SsoCredentialsProvider(
            fromString(id),
            this.createSsoClient(sourceProfile.ssoRegion, tokenProvider),
            tokenProvider,
            profile.ssoAccountId,
            profile.ssoRoleName
        )

        this.iamProfileProvider.addProvider(credentialsProvider)

        return credentialsProvider
    }

    // XXX: always read from the same location in a dev environment
    private getSsoSessionName = once(() => {
        try {
            const configFile = getConfigFilename()
            const contents: string = require('fs').readFileSync(configFile, 'utf-8')
            const identifier = contents.match(/\[sso\-session (.*)\]/)?.[1]
            if (!identifier) {
                throw new ToolkitError('No sso-session name found in ~/.aws/config', { code: 'NoSsoSessionName' })
            }

            return identifier
        } catch (err) {
            const defaultName = 'codecatalyst'
            getLogger().warn(`auth: unable to get an sso session name, defaulting to "${defaultName}": %s`, err)

            return defaultName
        }
    })

    private getTokenProvider(id: Connection['id'], profile: StoredProfile<SsoProfile>) {
        // XXX: Use the token created by dev environments if and only if the profile is strictly for CodeCatalyst
        const shouldUseSoftwareStatement =
            getCodeCatalystDevEnvId() !== undefined &&
            profile.startUrl === builderIdStartUrl &&
            profile.scopes?.every(scope => codecatalystScopes.includes(scope))

        const tokenIdentifier = shouldUseSoftwareStatement ? this.getSsoSessionName() : id

        return this.createTokenProvider(
            {
                identifier: tokenIdentifier,
                startUrl: profile.startUrl,
                scopes: profile.scopes,
                region: profile.ssoRegion,
            },
            this.#ssoCache
        )
    }

    private getIamConnection(
        id: Connection['id'],
        profile: StoredProfile<IamProfile>
    ): IamConnection & StatefulConnection {
        return {
            id,
            type: 'iam',
            state: profile.metadata.connectionState,
            label:
                profile.metadata.label ?? (profile.type === 'iam' && profile.subtype === 'linked' ? profile.name : id),
            getCredentials: async () => this.getCredentials(id, await this.getCredentialsProvider(id, profile)),
        }
    }

    private getSsoConnection(
        id: Connection['id'],
        profile: StoredProfile<SsoProfile>
    ): SsoConnection & StatefulConnection {
        const provider = this.getTokenProvider(id, profile)

        return {
            id,
            ...profile,
            state: profile.metadata.connectionState,
            label: profile.metadata?.label ?? this.getSsoProfileLabel(profile),
            getToken: () => this.getToken(id, provider),
        }
    }

    private readonly authenticate = keyedDebounce(this._authenticate.bind(this))
    private async _authenticate<T>(id: Connection['id'], callback: () => Promise<T>): Promise<T> {
        await this.updateConnectionState(id, 'authenticating')

        try {
            const result = await callback()
            await this.updateConnectionState(id, 'valid')

            return result
        } catch (err) {
            await this.handleValidationError(id, err)
            throw err
        }
    }

    private async createCachedCredentials(provider: CredentialsProvider) {
        const providerId = provider.getCredentialsId()
        globals.loginManager.store.invalidateCredentials(providerId)
        const { credentials } = await globals.loginManager.store.upsertCredentials(providerId, provider)
        await globals.loginManager.validateCredentials(credentials, provider.getDefaultRegion())

        return credentials
    }

    private async getCachedCredentials(provider: CredentialsProvider) {
        const creds = await globals.loginManager.store.getCredentials(provider.getCredentialsId())
        if (creds !== undefined && creds.credentialsHashCode === provider.getHashCode()) {
            return creds.credentials
        }
    }

    private readonly getToken = keyedDebounce(this._getToken.bind(this))
    private async _getToken(id: Connection['id'], provider: SsoAccessTokenProvider): Promise<SsoToken> {
        const token = await provider.getToken().catch(err => {
            // Bubble-up networking issues so we don't treat the session as invalid
            if (isNetworkError(err)) {
                throw new ToolkitError('Failed to refresh connection due to networking issues', {
                    cause: err,
                })
            }

            this.#validationErrors.set(id, err)
        })

        return token ?? this.handleInvalidCredentials(id, () => provider.createToken())
    }

    private readonly getCredentials = keyedDebounce(this._getCredentials.bind(this))
    private async _getCredentials(id: Connection['id'], provider: CredentialsProvider): Promise<Credentials> {
        const credentials = await this.getCachedCredentials(provider)
        if (credentials !== undefined) {
            return credentials
        } else if ((await provider.canAutoConnect()) === true) {
            return this.createCachedCredentials(provider)
        } else {
            return this.handleInvalidCredentials(id, () => this.createCachedCredentials(provider))
        }
    }

    private async handleInvalidCredentials<T>(id: Connection['id'], refresh: () => Promise<T>): Promise<T> {
        const profile = this.store.getProfile(id)
        const previousState = profile?.metadata.connectionState
        await this.updateConnectionState(id, 'invalid')

        if (previousState === 'invalid') {
            throw new ToolkitError('Connection is invalid or expired. Try logging in again.', {
                code: errorCode.invalidConnection,
                cause: this.#validationErrors.get(id),
            })
        }
        if (previousState === 'valid') {
            const timeout = new Timeout(60000)
            this.#invalidCredentialsTimeouts.set(id, timeout)

            const connLabel =
                profile?.metadata.label ?? (profile?.type === 'sso' ? this.getSsoProfileLabel(profile) : id)
            const message = localize(
                'aws.auth.invalidConnection',
                'Connection "{0}" is invalid or expired, login again?',
                connLabel
            )
            const login = localize('aws.auth.invalidConnection.loginAgain', 'Login')
            const resp = await Promise.race([
                vscode.window.showInformationMessage(message, login, localizedText.no),
                timeout.promisify(),
            ])

            if (resp !== login) {
                throw new ToolkitError('User cancelled login', {
                    cancelled: true,
                    code: errorCode.invalidConnection,
                    cause: this.#validationErrors.get(id),
                })
            }
        }

        return this.authenticate(id, refresh)
    }

    public readonly tryAutoConnect = once(async () => {
        if (this.activeConnection !== undefined) {
            return
        }

        // Clear anything stuck in an 'authenticating...' state
        // This can rarely happen when closing VS Code during authentication
        await Promise.all(
            this.store.listProfiles().map(async ([id, profile]) => {
                if (profile.metadata.connectionState === 'authenticating') {
                    await this.store.updateMetadata(id, { connectionState: 'invalid' })
                }
            })
        )

        // Use the environment token if available
        // This token only has CC permissions currently!
        if (getCodeCatalystDevEnvId() !== undefined) {
            const connections = (await this.listConnections()).filter(isBuilderIdConnection)

            if (connections.length === 0) {
                const key = uuid.v4()
                await this.store.addProfile(key, createBuilderIdProfile(codecatalystScopes))
                await this.store.setCurrentProfileId(key)
            }
        }

        const conn = await this.restorePreviousSession()
        if (conn !== undefined) {
            return
        }

        const defaultProfileId = asString({ credentialSource: 'profile', credentialTypeId: 'default' })
        const ec2ProfileId = asString({ credentialSource: 'ec2', credentialTypeId: 'instance' })
        const ecsProfileId = asString({ credentialSource: 'ecs', credentialTypeId: 'instance' })
        const legacyProfile = new CredentialsSettings().get('profile', defaultProfileId) || defaultProfileId
        const tryConnection = async (id: string) => {
            try {
                // Check for existence before using the connection to avoid noisy logs
                const conn = await this.getConnection({ id })
                if (conn === undefined) {
                    return false
                }

                await this.useConnection({ id })
                return true
            } catch (err) {
                getLogger().warn(`auth: failed to auto-connect using "${id}": %s`, err)
                return false
            }
        }

        await loadIamProfilesIntoStore(this.store, this.iamProfileProvider)
        for (const id of [ec2ProfileId, ecsProfileId, legacyProfile]) {
            if ((await tryConnection(id)) === true) {
                getLogger().info(`auth: automatically connected with "${id}"`)
                // Removes the setting from the UI
                if (id === legacyProfile) {
                    new CredentialsSettings().delete('profile')
                }
            }
        }
    })

    static #instance: Auth | undefined
    public static get instance() {
        const devEnvId = getCodeCatalystDevEnvId()
        const memento =
            devEnvId !== undefined ? partition(globals.context.globalState, devEnvId) : globals.context.globalState

        return (this.#instance ??= new Auth(new ProfileStore(memento)))
    }

    private getSsoProfileLabel(profile: SsoProfile) {
        const truncatedUrl = profile.startUrl.match(/https?:\/\/(.*)\.awsapps\.com\/start/)?.[1] ?? profile.startUrl

        return profile.startUrl === builderIdStartUrl
            ? localizedText.builderId()
            : `${localizedText.iamIdentityCenter} (${truncatedUrl})`
    }
}

export async function promptForConnection(auth: Auth, type?: 'iam' | 'sso') {
    const resp = await createConnectionPrompter(auth, type).prompt()
    if (!isValidResponse(resp)) {
        throw new CancellationError('user')
    }

    if (resp === 'addNewConnection') {
        return addConnection.execute()
    }

    if (resp === 'editCredentials') {
        return globals.awsContextCommands.onCommandEditCredentials()
    }

    return resp
}

export async function promptAndUseConnection(...[auth, type]: Parameters<typeof promptForConnection>) {
    return telemetry.aws_setCredentials.run(async span => {
        const resp = await promptForConnection(auth, type)
        if (!resp) {
            throw new CancellationError('user')
        }

        await auth.useConnection(resp)
    })
}

const switchConnections = Commands.register('aws.auth.switchConnections', (auth: Auth | unknown) => {
    telemetry.ui_click.emit({ elementId: 'devtools_connectToAws' })

    if (auth instanceof Auth) {
        return promptAndUseConnection(auth)
    } else {
        return promptAndUseConnection(getResourceFromTreeNode(auth, Instance(Auth)))
    }
})

export async function signout(auth: Auth, conn: Connection | undefined = auth.activeConnection) {
    if (conn?.type === 'sso') {
        // TODO: does deleting the connection make sense UX-wise?
        // this makes it disappear from the list of available connections
        await auth.deleteConnection(conn)

        const iamConnections = (await auth.listConnections()).filter(c => c.type === 'iam')
        const fallbackConn = iamConnections.find(c => c.id === 'profile:default') ?? iamConnections[0]
        if (fallbackConn !== undefined) {
            await auth.useConnection(fallbackConn)
        }
    } else {
        await auth.logout()

        const fallbackConn = (await auth.listConnections()).find(c => c.type === 'sso')
        if (fallbackConn !== undefined) {
            await auth.useConnection(fallbackConn)
        }
    }
}

export const createBuilderIdItem = () =>
    ({
        label: codicon`${getIcon('vscode-person')} ${localize(
            'aws.auth.builderIdItem.label',
            'Use a personal email to sign up and sign in with {0}',
            localizedText.builderId()
        )}`,
        data: 'builderId',
        onClick: () => telemetry.ui_click.emit({ elementId: 'connection_optionBuilderID' }),
        detail: `${localizedText.builderId()} is a new, personal profile for builders.`, // TODO: need a "Learn more" button ?
    } as DataQuickPickItem<'builderId'>)

export const createSsoItem = () =>
    ({
        label: codicon`${getIcon('vscode-organization')} ${localize(
            'aws.auth.ssoItem.label',
            'Connect using {0} {1}',
            getIdeProperties().company,
            localizedText.iamIdentityCenter
        )}`,
        data: 'sso',
        onClick: () => telemetry.ui_click.emit({ elementId: 'connection_optionSSO' }),
        detail: `Sign in to your company's ${localizedText.iamIdentityCenter} access portal login page.`,
    } as DataQuickPickItem<'sso'>)

export const createIamItem = () =>
    ({
        label: codicon`${getIcon('vscode-key')} ${localize('aws.auth.iamItem.label', 'Use IAM Credentials')}`,
        data: 'iam',
        onClick: () => telemetry.ui_click.emit({ elementId: 'connection_optionIAM' }),
        detail: 'Activates working with resources in the Explorer. Not supported by CodeWhisperer. Requires an access key ID and secret access key.',
    } as DataQuickPickItem<'iam'>)

export const isIamConnection = (conn?: Connection): conn is IamConnection => conn?.type === 'iam'
export const isSsoConnection = (conn?: Connection): conn is SsoConnection => conn?.type === 'sso'
export const isBuilderIdConnection = (conn?: Connection): conn is SsoConnection =>
    isSsoConnection(conn) && conn.startUrl === builderIdStartUrl

export async function createStartUrlPrompter(title: string, requiredScopes?: string[]) {
    const existingConnections = (await Auth.instance.listConnections()).filter(isSsoConnection)

    function validateSsoUrl(url: string) {
        if (!url.match(/^(http|https):\/\//i)) {
            return 'URLs must start with http:// or https://. Example: https://d-xxxxxxxxxx.awsapps.com/start'
        }

        try {
            const uri = vscode.Uri.parse(url, true)
            const isSameAuthority = (a: vscode.Uri, b: vscode.Uri) =>
                a.authority.toLowerCase() === b.authority.toLowerCase()
            const oldConn = existingConnections.find(conn => isSameAuthority(vscode.Uri.parse(conn.startUrl), uri))

            if (oldConn && (!requiredScopes || hasScopes(oldConn, requiredScopes))) {
                return 'A connection for this start URL already exists. Sign out before creating a new one.'
            }
        } catch (err) {
            return `URL is malformed: ${UnknownError.cast(err).message}`
        }
    }

    return createInputBox({
        title: `${title}: Enter Start URL`,
        placeholder: `Enter start URL for your organization's IAM Identity Center`,
        buttons: [createHelpButton(), createExitButton()],
        validateInput: validateSsoUrl,
    })
}

export async function createBuilderIdConnection(auth: Auth, scopes?: string[]) {
    const newProfile = createBuilderIdProfile(scopes)
    const existingConn = (await auth.listConnections()).find(isBuilderIdConnection)
    if (!existingConn) {
        return auth.createConnection(newProfile)
    }

    const userResponse = await promptLogoutExistingBuilderIdConnection()
    if (userResponse !== 'signout') {
        throw new CancellationError('user')
    }

    await signout(auth, existingConn)

    return auth.createConnection(newProfile)
}

/**
 * Prompts the user to log out of an existing Builder ID connection.
 *
 * @returns The name of the action performed by the user
 */
async function promptLogoutExistingBuilderIdConnection(): Promise<'signout' | 'cancel'> {
    const items: DataQuickPickItem<'signout' | 'cancel'>[] = [
        {
            data: 'signout',
            label: `Currently signed in with ${getIdeProperties().company} Builder ID. Sign out to add another?`,
            detail: `This will sign out of your current ${
                getIdeProperties().company
            } Builder ID and open the sign-in page in browser.`,
        },
        { data: 'cancel', label: 'Cancel' },
    ]
    const resp = await showQuickPick(items, {
        title: `Sign in to different ${getIdeProperties().company} Builder ID`,
        buttons: createCommonButtons() as vscode.QuickInputButton[],
    })

    return resp === undefined ? 'cancel' : resp
}

export async function showRegionPrompter(
    title: string = `IAM Identity Center: Select Region`,
    placeholder: string = `Select region for your organization's IAM Identity Center`
) {
    const region = await createRegionPrompter(undefined, {
        defaultRegion: defaultSsoRegion,
        buttons: createCommonButtons(),
        title: title,
        placeholder: placeholder,
    }).prompt()

    if (!isValidResponse(region)) {
        throw new CancellationError('user')
    }
    telemetry.ui_click.emit({ elementId: 'connection_region' })

    return region
}

Commands.register('aws.auth.help', async () => {
    vscode.env.openExternal(vscode.Uri.parse(authHelpUrl))
    telemetry.aws_help.emit()
})

Commands.register('aws.auth.signout', () => {
    telemetry.ui_click.emit({ elementId: 'devtools_signout' })
    return signout(Auth.instance)
})

const addConnection = Commands.register({ id: 'aws.auth.addConnection', telemetryThrottleMs: false }, async () => {
    const c9IamItem = createIamItem()
    c9IamItem.detail =
        'Activates working with resources in the Explorer. Requires an access key ID and secret access key.'
    const items = isCloud9() ? [createSsoItem(), c9IamItem] : [createBuilderIdItem(), createSsoItem(), createIamItem()]

    const resp = await showQuickPick(items, {
        title: localize('aws.auth.addConnection.title', 'Add a Connection to {0}', getIdeProperties().company),
        placeholder: localize('aws.auth.addConnection.placeholder', 'Select a connection option'),
        buttons: createCommonButtons() as vscode.QuickInputButton[],
    })
    if (!isValidResponse(resp)) {
        telemetry.ui_click.emit({ elementId: 'connection_optionescapecancel' })
        throw new CancellationError('user')
    }

    switch (resp) {
        case 'iam':
            return await globals.awsContextCommands.onCommandCreateCredentialsProfile()
        case 'sso': {
            const startUrlPrompter = await createStartUrlPrompter('IAM Identity Center')
            const startUrl = await startUrlPrompter.prompt()
            if (!isValidResponse(startUrl)) {
                throw new CancellationError('user')
            }
            telemetry.ui_click.emit({ elementId: 'connection_startUrl' })

            const region = await showRegionPrompter()

            const conn = await Auth.instance.createConnection(createSsoProfile(startUrl, region.id))
            return Auth.instance.useConnection(conn)
        }
        case 'builderId': {
            return createBuilderIdConnection(Auth.instance)
        }
    }
})

export async function tryAddCredentials(
    profileName: SectionName,
    profileData: StaticProfile,
    tryConnect = true
): Promise<boolean> {
    const auth = Auth.instance

    // sanity checks
    await throwOnInvalidCredentials(profileName, profileData)
    const authenticationError = await auth.authenticateData(profileData)
    if (authenticationError) {
        throw new ToolkitError(`Found error with '${authenticationError.key}':'${authenticationError.error}' `, {
            code: 'InvalidCredentials',
        })
    }

    await saveProfileToCredentials(profileName, profileData)

    if (tryConnect) {
        const id = asString({
            credentialSource: 'profile',
            credentialTypeId: profileName,
        })
        const conn = await auth.getConnection({ id })

        if (conn === undefined) {
            throw new ToolkitError(`Failed to get connection from profile: ${profileName}`, {
                code: 'MissingConnection',
            })
        }

        await auth.useConnection(conn)
    }
    return true
}

const getConnectionIcon = (conn: Connection) =>
    conn.type === 'sso' ? getIcon('vscode-account') : getIcon('vscode-key')

export function createConnectionPrompter(auth: Auth, type?: 'iam' | 'sso') {
    const addNewConnection = {
        label: codicon`${getIcon('vscode-plus')} Add New Connection`,
        data: 'addNewConnection' as const,
    }
    const editCredentials = {
        label: codicon`${getIcon('vscode-pencil')} Edit Credentials`,
        data: 'editCredentials' as const,
    }
    const placeholder =
        type === 'iam'
            ? localize('aws.auth.promptConnection.iam.placeholder', 'Select an IAM credential')
            : localize('aws.auth.promptConnection.all.placeholder', 'Select a connection')

    const refreshButton = createRefreshButton()
    refreshButton.onClick = () => void prompter.clearAndLoadItems(loadItems())

    // Place add/edit connection items at the bottom, then sort 'sso' connections
    // first, then valid connections, then finally the item label
    function getSortOrder(item: DataQuickPickItem<Connection | string>) {
        if (item.data === addNewConnection.data) {
            return 10
        } else if (item.data === editCredentials.data) {
            return 9
        }

        const conn = item.data as Connection
        if (conn.type === 'sso') {
            return 0
        } else if (auth.getConnectionState(conn) === 'valid') {
            return 1
        }

        return 2
    }

    const prompter = createQuickPick(loadItems(), {
        placeholder,
        title: localize('aws.auth.promptConnection.title', 'Switch Connection'),
        buttons: [refreshButton, createExitButton()],
        compare: (a, b) => {
            if (getSortOrder(a) === 0 && getSortOrder(b) === 0) {
                return a.label.localeCompare(b.label)
            }

            return getSortOrder(a) - getSortOrder(b)
        },
    })

    return prompter

    async function* loadItems(): AsyncGenerator<
        DataQuickPickItem<Connection | 'addNewConnection' | 'editCredentials'>[]
    > {
        const connections = auth.listAndTraverseConnections()

        let hasShownEdit = false

        yield [addNewConnection]
        for await (const conn of connections) {
            if (conn.label.includes('profile:') && !hasShownEdit) {
                hasShownEdit = true
                yield [toPickerItem(conn), editCredentials]
            } else {
                yield [toPickerItem(conn)]
            }
        }
    }

    function toPickerItem(conn: Connection): DataQuickPickItem<Connection> {
        const state = auth.getConnectionState(conn)
        if (state === 'valid') {
            return {
                data: conn,
                label: codicon`${getConnectionIcon(conn)} ${conn.label}`,
                description: getConnectionDescription(conn),
            }
        }

        const getDetail = () => {
            if (!DevSettings.instance.get('renderDebugDetails', false)) {
                return
            }

            const err = auth.getInvalidationReason(conn)
            return err ? formatError(err) : undefined
        }

        return {
            detail: getDetail(),
            data: conn,
            invalidSelection: state !== 'authenticating',
            label: codicon`${getIcon('vscode-error')} ${conn.label}`,
            description:
                state === 'authenticating'
                    ? 'authenticating...'
                    : localize(
                          'aws.auth.promptConnection.expired.description',
                          'Expired or Invalid, select to authenticate'
                      ),
            onClick:
                state !== 'authenticating'
                    ? async () => {
                          // XXX: this is hack because only 1 picker can be shown at a time
                          // Some legacy auth providers will show a picker, hiding this one
                          // If we detect this then we'll jump straight into using the connection
                          let hidden = false
                          const sub = prompter.quickPick.onDidHide(() => {
                              hidden = true
                              sub.dispose()
                          })
                          const newConn = await reauthCommand.execute(auth, conn)
                          if (hidden && newConn && auth.getConnectionState(newConn) === 'valid') {
                              await auth.useConnection(newConn)
                          } else {
                              await prompter.clearAndLoadItems(loadItems())
                              prompter.selectItems(
                                  ...prompter.quickPick.items.filter(i => i.label.includes(conn.label))
                              )
                          }
                      }
                    : undefined,
        }
    }

    function getConnectionDescription(conn: Connection) {
        if (conn.type === 'iam') {
            // TODO: implement a proper `getConnectionSource` method to discover where a connection came from
            const descSuffix = conn.id.startsWith('profile:')
                ? 'configured locally (~/.aws/config)'
                : conn.id.startsWith('sso:')
                ? 'sourced from IAM Identity Center'
                : 'sourced from the environment'

            return `IAM Credential, ${descSuffix}`
        }

        const toolAuths = getDependentAuths(conn)
        if (toolAuths.length === 0) {
            return undefined
        } else if (toolAuths.length === 1) {
            return `Connected to ${toolAuths[0].toolLabel}`
        } else {
            return `Connected to Dev Tools`
        }
    }
}

export const reauthCommand = Commands.register('_aws.auth.reauthenticate', async (auth: Auth, conn: Connection) => {
    try {
        return await auth.reauthenticate(conn)
    } catch (err) {
        throw ToolkitError.chain(err, 'Unable to authenticate connection')
    }
})

// Used to decouple from the `Commands` implementation
Commands.register('_aws.auth.autoConnect', () => Auth.instance.tryAutoConnect())

export const useIamCredentials = Commands.register('_aws.auth.useIamCredentials', (auth: Auth) => {
    telemetry.ui_click.emit({ elementId: 'explorer_IAMselect_VSCode' })

    return promptAndUseConnection(auth, 'iam')
})

// Legacy commands
export const login = Commands.register('aws.login', async (auth: Auth = Auth.instance) => {
    const connections = await auth.listConnections()
    if (connections.length === 0) {
        return addConnection.execute()
    } else {
        return switchConnections.execute(auth)
    }
})
Commands.register('aws.logout', () => signout(Auth.instance))
Commands.register('aws.credentials.edit', () => globals.awsContextCommands.onCommandEditCredentials())
Commands.register('aws.credentials.profile.create', async () => {
    try {
        await globals.awsContextCommands.onCommandCreateCredentialsProfile()
    } finally {
        telemetry.aws_createCredentials.emit()
    }
})

function mapEventType<T, U = void>(event: vscode.Event<T>, fn?: (val: T) => U): vscode.Event<U> {
    const emitter = new vscode.EventEmitter<U>()
    event(val => (fn ? emitter.fire(fn(val)) : emitter.fire(undefined as U)))

    return emitter.event
}

export class AuthNode implements TreeNode<Auth> {
    public readonly id = 'auth'
    public readonly onDidChangeTreeItem = mapEventType(this.resource.onDidChangeActiveConnection)

    public constructor(public readonly resource: Auth) {}

    public getTreeItem() {
        // Calling this here is robust but `TreeShim` must be instantiated lazily to stop side-effects
        this.resource.tryAutoConnect()

        if (!this.resource.hasConnections) {
            const item = new vscode.TreeItem(`Connect to ${getIdeProperties().company} to Get Started...`)
            item.command = addConnection.build().asCommand({ title: 'Add Connection' })

            return item
        }

        const conn = this.resource.activeConnection
        const itemLabel =
            conn?.label !== undefined
                ? localize('aws.auth.node.connected', `Connected with {0}`, conn.label)
                : localize('aws.auth.node.selectConnection', 'Select a connection...')

        const item = new vscode.TreeItem(itemLabel)
        item.contextValue = 'awsAuthNode'

        if (conn !== undefined && conn.state !== 'valid') {
            item.iconPath = getIcon('vscode-error')
            if (conn.state === 'authenticating') {
                this.setDescription(item, 'authenticating...')
            } else {
                this.setDescription(item, 'expired or invalid, click to authenticate')
                item.command = reauthCommand.build(this.resource, conn).asCommand({ title: 'Reauthenticate' })
            }
        } else {
            item.command = switchConnections.build(this.resource).asCommand({ title: 'Login' })
            item.iconPath = conn !== undefined ? getConnectionIcon(conn) : undefined
        }

        return item
    }

    private setDescription(item: vscode.TreeItem, text: string) {
        if (isCloud9()) {
            item.tooltip = item.tooltip ?? text
        } else {
            item.description = text
        }
    }
}
