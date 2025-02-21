const crypto = require('crypto');
const { inspect } = require('util');
const assert = require('assert');

class SequelizeSimpleCache {
  constructor(config = {}, options = {}) {
    const defaults = {
      ttl: 60 * 60, // 1 hour
      methods: [
        'findOne',
        'findAndCountAll',
        'findByPk',
        'findAll',
        'count',
        'min',
        'max',
        'sum',
        'find',
        'findAndCount',
        'findById',
        'findByPrimary',
        'all',
      ],
      methodsUpdate: [
        'create',
        'bulkCreate',
        'update',
        'destroy',
        'upsert',
        'findOrBuild',
        'insertOrUpdate',
        'findOrInitialize',
        'updateAttributes',
        'save',
      ],
      limit: 50,
      clearOnUpdate: true,
    };
    this.config = Object.entries(config).reduce(
      (
        acc,
        [
          type,
          {
            ttl = defaults.ttl,
            methods = defaults.methods,
            methodsUpdate = defaults.methodsUpdate,
            limit = defaults.limit,
            clearOnUpdate = defaults.clearOnUpdate,
          },
        ]
      ) => ({
        ...acc,
        [type]: {
          ttl,
          methods,
          methodsUpdate,
          limit,
          clearOnUpdate,
        },
      }),
      {}
    );
    const {
      debug = false,
      ops = 0, // eslint-disable-next-line no-console
      delegate = (event, details) => console.debug(`CACHE ${event.toUpperCase()}`, details),
    } = options;
    this.debug = debug;
    this.ops = ops;
    this.delegate = delegate;
    this.cache = {};
    this.associations = new Map();
    this.stats = {
      hit: 0,
      miss: 0,
      load: 0,
      purge: 0,
    };
    if (this.ops > 0) {
      this.heart = setInterval(() => {
        this.log('ops');
      }, this.ops * 1000);
    }
  }

  static key(obj) {
    // Unfortunately, there seem to be no stringify or object hashes that work correctly
    // with ES6 symbols and function objects. But this is important for Sequelize queries.
    // This is the only solution that seems to be working.
    return inspect(obj, {
      depth: Infinity,
      maxArrayLength: Infinity,
      breakLength: Infinity,
    });
  }

  init(model) {
    // Sequelize model object
    const { name: type } = model;
    // setup caching for this model
    const config = this.config[type];
    let cache;
    if (config) {
      cache = new Map();
      this.cache[type] = cache;
    }
    this.log('init', { type, ...(config || {}) });

    // Return proxy to intercept Sequelize methods and cache decorators
    return new Proxy(model, {
      get: (target, prop) => {
        if (prop === 'associate' && typeof target[prop] === 'function') {
          return this._wrapAssociateMethod(target);
        }
        // caching interface on model
        if (prop === 'noCache') {
          return () => model;
        }
        if (prop === 'clearCache') {
          return () => this.clear(type);
        }
        if (prop === 'clearCacheAll') {
          return () => this.clear();
        }
        // no caching for this model
        if (!config) {
          return target[prop];
        }
        // intercept Sequelize methods on model
        const { ttl, methods, methodsUpdate, limit, clearOnUpdate } = config;
        if (![...methods, ...methodsUpdate].includes(prop)) {
          return target[prop];
        }
        if (methodsUpdate.includes(prop)) {
          const result = target[prop];
          if (clearOnUpdate) {
            this.clear(type);
          }
          return result;
        }
        const fn = async (...args) => {
          const withinTxn = args.reduce((acc, { transaction }) => acc || transaction, false);
          if (withinTxn) {
            // bypass cache
            const promise = target[prop](...args);
            assert(promise.then, `${type}.${prop}() did not return a promise but should`);
            return promise;
          }
          const key = SequelizeSimpleCache.key({
            type,
            prop,
            args,
          });
          const hash = crypto.createHash('md5').update(key).digest('hex');
          const item = cache.get(hash);
          if (item) {
            // hit
            const { data, expires } = item;
            if (!expires || expires > Date.now()) {
              this.log('hit', {
                key,
                hash,
                expires,
              });
              return data; // resolve from cache
            }
          }
          this.log('miss', {
            key,
            hash,
          });
          const promise = target[prop](...args);
          assert(promise.then, `${type}.${prop}() did not return a promise but should`);
          return promise.then((data) => {
            if (data !== undefined && data !== null) {
              const expires = ttl > 0 ? Date.now() + ttl * 1000 : false;
              cache.set(hash, {
                data,
                expires,
              });
              this.log('load', {
                key,
                hash,
                expires,
              });
              if (cache.size > limit) {
                this.purge(type);
              }
            }
            return data; // resolve from database
          });
        };
        // proxy for supporting Sinon-decorated properties on mocked model functions
        return new Proxy(fn, {
          get: (_, deco) => {
            // eslint-disable-line consistent-return
            if (Reflect.has(target, prop) && Reflect.has(target[prop], deco)) {
              return target[prop][deco]; // e.g., `User.findOne.restore`
            }
          },
        });
      },
    });
  }

  clear(...modelNames) {
    const types = modelNames.length ? modelNames : Object.keys(this.cache);
    const typesToClear = new Set();
    const queue = [...types]; // Queue to process associated types
    const visited = new Set(); // Prevent infinite loops

    while (queue.length) {
      const type = queue.shift();
      if (visited.has(type)) {
        continue;
      }

      visited.add(type);
      typesToClear.add(type);

      if (this.associations.get(type)) {
        this.associations.get(type).forEach((assocType) => {
          if (!visited.has(assocType)) {
            queue.push(assocType);
          }
        });
      }
    }

    typesToClear.forEach((type) => {
      if (this.cache[type]) {
        this.cache[type].clear();
      }
    });
  }

  size(...modelNames) {
    const types = modelNames.length ? modelNames : Object.keys(this.cache);
    return types
      .filter((type) => this.cache[type])
      .reduce((acc, type) => acc + this.cache[type].size, 0);
  }

  purge(...modelNames) {
    const types = modelNames.length ? modelNames : Object.keys(this.cache);
    const now = Date.now();
    types.forEach((type) => {
      const cache = this.cache[type];
      if (!cache) return;
      let oldest;
      cache.forEach(({ expires }, hash) => {
        if (expires && expires <= now) {
          cache.delete(hash);
          this.log('purge', {
            hash,
            expires,
          });
        } else if (!oldest || expires < oldest.expires) {
          oldest = {
            hash,
            expires,
          };
        }
      });
      const { limit } = this.config[type];
      if (cache.size > limit && oldest) {
        cache.delete(oldest.hash);
        this.log('purge', oldest);
      }
    });
  }

  log(event, details = {}) {
    // stats
    if (this.stats[event] >= 0) {
      this.stats[event] += 1;
    }
    // logging
    if (!this.debug && event !== 'ops') return;
    this.delegate(event, {
      ...details,
      ...this.stats,
      ratio: this.stats.hit / (this.stats.hit + this.stats.miss),
      size: Object.entries(this.cache).reduce(
        (acc, [type, map]) => ({
          ...acc,
          [type]: map.size,
        }),
        {}
      ),
    });
  }

  _wrapAssociateMethod(target) {
    const originalAssociate = target.associate;

    return (...args) => {
      // Calls the original Associate method
      const result = originalAssociate.apply(target, args);

      // After associate is called, associations should be available
      this._registerAssociations(target);

      return result;
    };
  }

  _registerAssociations(target) {
    if (!target.associations) return;

    const associatedModels = Object.values(target.associations)
      .map((association) => association.target?.name)
      .filter(Boolean);

    if (associatedModels.length === 0) return;

    this._addAssociations(target.name, associatedModels);
    this._addReverseAssociations(target.name, associatedModels);
  }

  _addAssociations(modelName, associatedModels) {
    this.associations.set(modelName, associatedModels);
  }

  _addReverseAssociations(modelName, associatedModels) {
    for (const associatedModel of associatedModels) {
      if (!this.associations.has(associatedModel)) {
        this.associations.set(associatedModel, []);
      }
      if (!this.associations.get(associatedModel).includes(modelName)) {
        this.associations.get(associatedModel).push(modelName);
      }
    }
  }
}

module.exports = SequelizeSimpleCache;
