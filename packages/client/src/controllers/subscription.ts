import { EventEmitter } from "events";
import { Logger } from "pino";
import {
  IClient,
  ISubscription,
  SubscriptionEvent,
  SubscriptionOptions,
  SubscriptionParams,
} from "@walletconnect/types";
import { JsonRpcPayload } from "@json-rpc-tools/utils";

import { SUBSCRIPTION_DEFAULT_TTL, SUBSCRIPTION_EVENTS } from "../constants";
import { generateChildLogger, getLoggerContext } from "@pedrouid/pino-utils";

export class Subscription<Data = any> extends ISubscription<Data> {
  public subscriptions = new Map<string, SubscriptionParams<Data>>();

  public events = new EventEmitter();

  private timeout = new Map<string, NodeJS.Timeout>();

  private cached: SubscriptionParams<Data>[] = [];

  constructor(
    public client: IClient,
    public logger: Logger,
    public context: string,
    public encrypted: boolean,
  ) {
    super(client, logger, context, encrypted);
    this.logger = generateChildLogger(logger, this.context);

    this.registerEventListeners();
  }

  public async init(): Promise<void> {
    this.logger.trace(`Initialized`);
    await this.restore();
  }

  get length(): number {
    return this.subscriptions.size;
  }

  get topics(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  get values(): SubscriptionParams<Data>[] {
    return Array.from(this.subscriptions.values());
  }

  public async set(topic: string, data: Data, opts: SubscriptionOptions): Promise<void> {
    await this.isEnabled();
    if (this.subscriptions.has(topic)) {
      this.update(topic, data);
    } else {
      this.logger.debug(`Setting subscription`);
      this.logger.trace({ type: "method", method: "set", topic, data, opts });
      if (this.encrypted && typeof opts.decryptKeys === "undefined") {
        const errorMessage = `Decrypt params required for ${this.getSubscriptionContext()}`;
        this.logger.error(errorMessage);
        throw new Error(errorMessage);
      }
      await this.subscribeAndSet(topic, data, opts);
      this.events.emit(SUBSCRIPTION_EVENTS.created, {
        topic,
        data,
      } as SubscriptionEvent.Created<Data>);
    }
  }

  public async get(topic: string): Promise<Data> {
    await this.isEnabled();
    this.logger.debug(`Getting subscription`);
    this.logger.trace({ type: "method", method: "get", topic });
    const subscription = await this.getSubscription(topic);
    return subscription.data;
  }

  public async update(topic: string, update: Partial<Data>): Promise<void> {
    await this.isEnabled();
    this.logger.debug(`Updating subscription`);
    this.logger.trace({ type: "method", method: "update", topic, update });
    const subscription = await this.getSubscription(topic);
    const data = { ...subscription.data, ...update };
    this.subscriptions.set(topic, {
      ...subscription,
      topic,
      data,
    });
    this.events.emit(SUBSCRIPTION_EVENTS.updated, {
      topic,
      data,
      update,
    } as SubscriptionEvent.Updated<Data>);
  }

  public async delete(topic: string, reason: string): Promise<void> {
    await this.isEnabled();

    this.logger.debug(`Deleting subscription`);
    this.logger.trace({ type: "method", method: "delete", topic, reason });
    const subscription = await this.getSubscription(topic);
    this.subscriptions.delete(topic);
    await this.client.relayer.unsubscribe(subscription.id, {
      relay: subscription.opts.relay,
      decryptKeys: subscription.opts.decryptKeys,
    });
    this.events.emit(SUBSCRIPTION_EVENTS.deleted, {
      topic,
      data: subscription.data,
      reason,
    } as SubscriptionEvent.Deleted<Data>);
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  // ---------- Protected ----------------------------------------------- //

  protected async onPayload(payloadEvent: SubscriptionEvent.Payload) {
    this.events.emit(SUBSCRIPTION_EVENTS.payload, payloadEvent);
  }

  // ---------- Private ----------------------------------------------- //

  private getNestedContext(length: number) {
    const nestedContext = getLoggerContext(this.logger).split("/");
    return nestedContext.slice(nestedContext.length - length, nestedContext.length);
  }

  private getSubscriptionContext() {
    return this.getNestedContext(2).join(" ");
  }

  private getStorageKey() {
    const storageKeyPrefix = `${this.client.protocol}@${this.client.version}:${this.client.context}`;
    const subscriptionContext = this.getNestedContext(2).join(":");
    return `${storageKeyPrefix}//${subscriptionContext}`;
  }

  private async getSubscription(topic: string): Promise<SubscriptionParams<Data>> {
    await this.isEnabled();
    const subscription = this.subscriptions.get(topic);
    if (!subscription) {
      const errorMessage = `No matching ${this.getSubscriptionContext()} with topic: ${topic}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    return subscription;
  }

  private async subscribeAndSet(
    topic: string,
    data: Data,
    opts: SubscriptionOptions,
  ): Promise<void> {
    const id = await this.client.relayer.subscribe(
      topic,
      (payload: JsonRpcPayload) => this.onPayload({ topic, payload }),
      opts,
    );
    const expiry = opts.expiry || Date.now() + SUBSCRIPTION_DEFAULT_TTL;
    this.subscriptions.set(topic, { id, topic, data, opts });
    this.setTimeout(topic, expiry);
  }

  private setTimeout(topic: string, expiry: number) {
    if (this.timeout.has(topic)) return;
    const ttl = expiry - Date.now();
    if (ttl <= 0) {
      this.onTimeout(topic);
      return;
    }
    const timeout = setTimeout(() => this.onTimeout(topic), ttl);
    this.timeout.set(topic, timeout);
  }

  public deleteTimeout(topic: string): void {
    if (!this.timeout.has(topic)) return;
    const timeout = this.timeout.get(topic);
    if (typeof timeout === "undefined") return;
    clearTimeout(timeout);
  }

  public resetTimeout(): void {
    this.timeout.forEach(timeout => clearTimeout(timeout));
    this.timeout.clear();
  }

  private onTimeout(topic: string): void {
    this.deleteTimeout(topic);
    this.delete(topic, "Expired");
  }

  private async persist() {
    await this.client.storage.setItem<SubscriptionParams<Data>[]>(
      this.getStorageKey(),
      this.values,
    );
  }

  private async restore() {
    try {
      const persisted = await this.client.storage.getItem<SubscriptionParams<Data>[]>(
        this.getStorageKey(),
      );
      if (typeof persisted === "undefined") return;
      if (!persisted.length) return;
      if (this.subscriptions.size) {
        const errorMessage = `Restore will override already set ${this.getSubscriptionContext()}`;
        this.logger.error(errorMessage);
        throw new Error(errorMessage);
      }
      this.cached = persisted;
      await Promise.all(
        this.cached.map(async subscription => {
          const { topic, data, opts } = subscription;
          await this.subscribeAndSet(topic, data, opts);
        }),
      );
      await this.enable();
      this.logger.debug(`Successfully Restored subscriptions for ${this.getSubscriptionContext()}`);
      this.logger.trace({ type: "method", method: "restore", subscriptions: this.values });
    } catch (e) {
      this.logger.debug(`Failed to Restore subscriptions for ${this.getSubscriptionContext()}`);
      this.logger.error(e);
    }
  }

  private async reset(): Promise<void> {
    await this.disable();
    await Promise.all(
      this.cached.map(async subscription => {
        const { topic, data, opts } = subscription;
        await this.subscribeAndSet(topic, data, opts);
      }),
    );
    await this.enable();
  }

  private async isEnabled(): Promise<void> {
    if (!this.cached.length) return;
    return new Promise(resolve => {
      this.events.once("enabled", () => resolve());
    });
  }

  private async enable(): Promise<void> {
    this.cached = [];
    this.events.emit("enabled");
  }

  private async disable(): Promise<void> {
    if (!this.cached.length) {
      this.cached = this.values;
    }
    this.resetTimeout();
    this.events.emit("disabled");
  }

  private registerEventListeners(): void {
    this.client.relayer.on("connect", () => this.reset());
    this.events.on(SUBSCRIPTION_EVENTS.payload, (payloadEvent: SubscriptionEvent.Payload) => {
      this.logger.info(`Emitting ${SUBSCRIPTION_EVENTS.created}`);
      this.logger.debug({ type: "event", event: SUBSCRIPTION_EVENTS.created, data: payloadEvent });
    });
    this.events.on(SUBSCRIPTION_EVENTS.created, (createdEvent: SubscriptionEvent.Created<Data>) => {
      this.logger.info(`Emitting ${SUBSCRIPTION_EVENTS.created}`);
      this.logger.debug({ type: "event", event: SUBSCRIPTION_EVENTS.created, data: createdEvent });
      this.persist();
    });
    this.events.on(SUBSCRIPTION_EVENTS.updated, (updatedEvent: SubscriptionEvent.Updated<Data>) => {
      this.logger.info(`Emitting ${SUBSCRIPTION_EVENTS.updated}`);
      this.logger.debug({ type: "event", event: SUBSCRIPTION_EVENTS.updated, data: updatedEvent });
      this.persist();
    });
    this.events.on(SUBSCRIPTION_EVENTS.deleted, (deletedEvent: SubscriptionEvent.Deleted<Data>) => {
      this.logger.info(`Emitting ${SUBSCRIPTION_EVENTS.updated}`);
      this.logger.debug({ type: "event", event: SUBSCRIPTION_EVENTS.updated, data: deletedEvent });
      this.persist();
    });
  }
}
