
# @lepauloricardo/sequelize-simple-cache


## Overview

This is a fork of [sequelize-simple-cache](https://github.com/funny-bytes/sequelize-simple-cache)

In this fork, I have added support for associations when clearing the cache.
This works in my specific configuration, and no additional tests were added.
This library is not actively maintained, so use it at your own risk.



## Installation

```bash
npm install @lepauloricardo/sequelize-simple-cache
```

## Usage

Set up the cache and load your Sequelize models like this:

```javascript
const Sequelize = require('sequelize');
const SequelizeSimpleCache = require('@lepauloricardo/sequelize-simple-cache');

// create db connection
const sequelize = new Sequelize('database', 'username', 'password', { ... });

// create cache -- referring to Sequelize models by name, e.g., `User`
const cache = new SequelizeSimpleCache({
  User: { ttl: 5 * 60 }, // 5 minutes
  Page: { }, // default ttl is 1 hour
});

// assuming you have your models in separate files with "model definers"
// add your models to the cache like this
const User = cache.init(require('./models/user')(sequelize));
const Page = cache.init(require('./models/page')(sequelize));

// no caching for this one (because it's not configured to be cached)
const Order = cache.init(require('./models/order')(sequelize));

// Sequelize model API is fully transparent, no need to change anything.
// first time resolved from the database, subsequent times from the cache.
const fred = await User.findOne({ where: { name: 'fred' }});
```

Example model definition:

```javascript
const { Model } = require('sequelize');
class User extends Model {}
module.exports = (sequelize) => User.init({ /* attributes */ }, { sequelize });
```

Note: `SequelizeSimpleCache` refers to Sequelize **models by name**.
By default, the model name is equal to the class name (e.g., `User` for `class User extends Model {}`).

## Key Features

### Supported methods

The following methods are supported for caching:
- `findOne`, `findAndCountAll`, `findByPk`, `findAll`, `count`, `min`, `max`, `sum`.
- For Sequelize v4: `find`, `findAndCount`, `findById`, `findByPrimary`, `all`.

### Bypass caching

To bypass the cache for a specific query:

```javascript
Model.noCache().findOne(/* ... */);
```

### Time-to-live (TTL)

Each model has an individual TTL, i.e., all database requests for a model are cached for a specific number of seconds. The default TTL is one hour.

For eternal caching (no TTL), set the model's `ttl` to `false` or any number less than or equal to `0`.

```javascript
const cache = new SequelizeSimpleCache({
  User: { ttl: 5 * 60 }, // 5 minutes
  Page: { ttl: false }, // cache forever
});
```

### Clear Cache

You can clear the cache in several ways:

```javascript
const cache = new SequelizeSimpleCache({ /* ... */ });
// clear all caches
cache.clear();
// clear specific models
cache.clear('User', 'Page');
// clear a single model's cache
Model.clearCache();
// clear all model caches
Model.clearCacheAll();
```

By default, the cache is cleared automatically after the following actions:
- `update`, `create`, `upsert`, `destroy`, `findOrBuild`.

You can customize this behavior:

```javascript
const cache = new SequelizeSimpleCache({
  User: { }, // default clearOnUpdate is true
  Page: { clearOnUpdate: false },
});
```

### Limit Cache Size

This cache is designed for small datasets. You can set limits for the cache size.

```javascript
const cache = new SequelizeSimpleCache({
  User: { }, // default limit is 50
  Page: { limit: 30 },
});
```

### Logging

You can enable logging for cache events:

```javascript
const cache = new SequelizeSimpleCache({
  // ...
}, {
  debug: true,
  ops: 60, // seconds
  delegate: (event, details) => { ... },
});
```

### Unit Testing

If you mock your Sequelize models in unit tests, you can clear the cache as needed:

```javascript
describe('My Test Suite', () => {
  beforeEach(() => {
    Model.clearCacheAll();
  });
  // ...
});
```

Or disable caching entirely during tests:

```javascript
const config = require('config');
const useCache = config.get('database.cache');
const cache = useCache ? new SequelizeSimpleCache({/* ... */}) : undefined;
```

## TypeScript Support

`SequelizeSimpleCache` includes TypeScript definitions.

To use this module with TypeScript, ensure your compiler options include:
- `"target": "ES2015"` (or later),
- `"moduleResolution": "node"`,
- `"esModuleInterop": true`.
