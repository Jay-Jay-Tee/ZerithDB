import Dexie, { type Table } from "dexie";
import { v7 as uuidv7 } from "uuid";
import type {
  ZerithDBConfig,
  Document,
  QueryFilter,
  InsertResult,
  UpdateSpec,
} from "zerithdb-core";
import { ZerithDBError, ErrorCode } from "zerithdb-core";

/**
 * A handle to a single named collection within the ZerithDB local database.
 * All operations are async and backed by IndexedDB.
 */
export class CollectionClient<T extends Record<string, any> = Record<string, any>> {
  private readonly subscribers = new Set<(documents: Document<T>[]) => void>();

  constructor(
    private readonly getTable: () => Promise<Table<Document<T>>>,
    private readonly collectionName: string
  ) {}

  /**
   * Insert a new document into the collection.
   * Automatically assigns `_id`, `_createdAt`, and `_updatedAt`.
   */
  async insert(document: T): Promise<InsertResult> {
    const now = Date.now();
    const id = uuidv7();
    const doc: Document<T> = {
      ...document,
      _id: id,
      _createdAt: now,
      _updatedAt: now,
    };

    try {
      const table = await this.getTable();
      await table.add(doc);
      await this.notifySubscribers();
      return { id };
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to insert into collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }
  /**
   * Insert multiple documents in a single atomic operation.
   */
  async insertMany(documents: T[]): Promise<InsertResult[]> {
    const now = Date.now();
    const docs = documents.map((doc) => ({
      ...doc,
      _id: uuidv7(),
      _createdAt: now,
      _updatedAt: now,
    })) as Document<T>[];

    try {
      const table = await this.getTable();
      await table.bulkAdd(docs);
      await this.notifySubscribers();
      return docs.map((d) => ({ id: d._id }));
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to bulk insert into collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Find documents matching a filter.
   * All filter fields are ANDed together.
   *
   * @example
   * ```typescript
   * const active = await todos.find({ done: false });
   * const high = await todos.find({ priority: { $gte: 3 } });
   * ```
   */
  async find(filter: QueryFilter<T> = {}): Promise<Document<T>[]> {
    try {
      const table = await this.getTable();
      const all = await table.toArray();
      return all.filter((doc: Document<T>) => this.matchesFilter(doc, filter));
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to query collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Find a single document by its `_id`.
   */
  async findById(id: string): Promise<Document<T> | undefined> {
    try {
      const table = await this.getTable();
      return await table.get(id);
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to get document "${id}" from "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Update documents matching a filter.
   * Returns the number of updated documents.
   */
  async update(filter: QueryFilter<T>, spec: UpdateSpec<T>): Promise<number> {
    try {
      const matches = await this.find(filter);
      const now = Date.now();

      const table = await this.getTable();
      await table.bulkPut(matches.map((doc) => this.applyUpdateSpec(doc, spec, now)));

      await this.notifySubscribers();

      return matches.length;
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to update documents in "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Delete documents matching a filter.
   * Returns the number of deleted documents.
   */
  async delete(id: string): Promise<number>;
  async delete(filter: QueryFilter<T>): Promise<number>;
  async delete(target: QueryFilter<T> | string): Promise<number> {
    const filter = typeof target === "string" ? ({ _id: target } as QueryFilter<T>) : target;

    try {
      const matches = await this.find(filter);
      const table = await this.getTable();
      await table.bulkDelete(matches.map((d) => d._id));
      await this.notifySubscribers();
      return matches.length;
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_DELETE_FAILED,
        `Failed to delete documents from "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Delete every document in the collection.
   */
  async clearAll(): Promise<void> {
    try {
      const table = await this.getTable();
      await table.clear();
      await this.notifySubscribers();
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_DELETE_FAILED,
        `Failed to clear collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Subscribe to collection snapshots.
   * The callback receives the current documents immediately and after every mutation.
   */
  subscribe(callback: (documents: Document<T>[]) => void): () => void {
    this.subscribers.add(callback);

    void this.find({})
      .then((documents) => {
        if (this.subscribers.has(callback)) {
          callback(documents);
        }
      })
      .catch(() => {
        // Best-effort initial snapshot; subsequent mutations still notify subscribers.
      });

    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Count documents matching a filter.
   */
  async count(filter: QueryFilter<T> = {}): Promise<number> {
    const docs = await this.find(filter);
    return docs.length;
  }

  private applyUpdateSpec(doc: Document<T>, spec: UpdateSpec<T>, updatedAt: number): Document<T> {
    const next = {
      ...doc,
      ...(spec.$set ?? {}),
      _updatedAt: updatedAt,
    } as Record<string, any>;

    for (const key of Object.keys(spec.$unset ?? {})) {
      delete next[key];
    }

    next._id = doc._id;
    next._createdAt = doc._createdAt;
    next._updatedAt = updatedAt;

    return next as Document<T>;
  }

  private matchesFilter(doc: Document<T>, filter: QueryFilter<T>): boolean {
    for (const [key, condition] of Object.entries(filter)) {
      const fieldValue = (doc as Record<string, any>)[key];

      if (condition === null || typeof condition !== "object") {
        if (fieldValue !== condition) return false;
        continue;
      }

      const ops = condition as Record<string, any>;
      if ("$eq" in ops && fieldValue !== ops["$eq"]) return false;
      if ("$ne" in ops && fieldValue === ops["$ne"]) return false;
      if ("$gt" in ops && !((fieldValue as any) > (ops["$gt"] as never))) return false;
      if ("$gte" in ops && !((fieldValue as any) >= (ops["$gte"] as never))) return false;
      if ("$lt" in ops && !((fieldValue as any) < (ops["$lt"] as never))) return false;
      if ("$lte" in ops && !((fieldValue as any) <= (ops["$lte"] as never))) return false;
      if ("$in" in ops && !(ops["$in"] as unknown[]).includes(fieldValue)) return false;
      if ("$nin" in ops && (ops["$nin"] as unknown[]).includes(fieldValue)) return false;
    }
    return true;
  }

  private async notifySubscribers(): Promise<void> {
    if (this.subscribers.size === 0) return;

    let documents: Document<T>[];
    try {
      documents = await this.find({});
    } catch {
      return;
    }

    for (const callback of this.subscribers) {
      callback(documents);
    }
  }
}

class ZerithDBDexie extends Dexie {
  private readonly tableMap = new Map<string, Table>();

  constructor(appId: string) {
    super(`zerithdb_${appId}`);
  }

  async ensureCollection(name: string): Promise<Table> {
    if (!this.tableMap.has(name)) {
      if (this.isOpen()) {
        this.close();
      }

      // Dexie requires version upgrade to add tables — we use a dynamic schema pattern
      const version = (this.verno ?? 0) + 1;
      const existingTableNames = this.tableMap.keys();
      const schema: Record<string, string> = { [name]: "_id, _createdAt, _updatedAt" };
      for (const existingName of existingTableNames) {
        schema[existingName] = "_id, _createdAt, _updatedAt";
      }
      this.version(version).stores(schema);
      for (const collectionName of Object.keys(schema)) {
        this.tableMap.set(collectionName, this.table(collectionName));
      }

      await this.open();
    } else if (!this.isOpen()) {
      await this.open();
    }
    // biome-ignore lint: map guarantees this is defined
    return this.tableMap.get(name)!;
  }
}

/**
 * Internal database client. Wraps Dexie and manages collection instances.
 * Use via {@link ZerithDBApp.db} — not instantiated directly.
 */
export class DbClient {
  private readonly dexie: ZerithDBDexie;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly collections = new Map<string, CollectionClient<any>>();

  constructor(config: ZerithDBConfig) {
    this.dexie = new ZerithDBDexie(config.appId);
  }

  collection<T extends Record<string, any>>(name: string): CollectionClient<T> {
    if (!this.collections.has(name)) {
      this.collections.set(
        name,
        new CollectionClient<T>(
          async () => (await this.dexie.ensureCollection(name)) as Table<Document<T>>,
          name
        )
      );
    }
    return this.collections.get(name) as CollectionClient<T>;
  }

  async dispose(): Promise<void> {
    this.dexie.close();
  }
}
