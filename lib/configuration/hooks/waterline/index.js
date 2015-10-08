'use strict';

/**
 * Module dependencies
 */

// Node.js core.
const path = require('path');
const spawn = require('child_process').spawnSync;

// Public node modules.
const _ = require('lodash');
const async = require('async');
const Waterline = require('waterline');

// Local utilities.
const helpers = require('./helpers/index');

/**
 * Waterline ORM hook
 */

module.exports = function (strapi) {
  const hook = {

    /**
     * Default options
     */

    defaults: {
      orm: {
        adapters: {
          disk: 'sails-disk'
        },
        defaultConnection: 'default',
        connections: {
          default: {
            adapter: 'disk',
            filePath: '.tmp/',
            fileName: 'default.db',
            migrate: 'alter'
          },
          permanent: {
            adapter: 'disk',
            filePath: './data/',
            fileName: 'permanent.db',
            migrate: 'alter'
          }
        }
      },
      globals: {
        models: true
      }
    },

    /**
     * Initialize the hook
     */

    initialize: function (cb) {
      if (_.isPlainObject(strapi.config.orm) && !_.isEmpty(strapi.config.orm)) {
        strapi.adapters = {};

        // Expose a new instance of Waterline.
        if (!strapi.orm) {
          strapi.orm = new Waterline();
        }

        // Prefix every adapter and require them from the
        // `node_modules` directory of the application.
        _.forEach(strapi.config.orm.adapters, function (adapter, name) {
          try {
            strapi.adapters[name] = require(path.resolve(strapi.config.appPath, 'node_modules', adapter));
          } catch (err) {
            if (strapi.config.environment === 'development') {
              strapi.log.warn('Installing the `' + adapter + '` adapter, please wait...');
              spawn('npm', ['install', adapter, '--save']);
            } else {
              strapi.log.error('The adapter `' + adapter + '` is not installed.');
              strapi.log.error('Execute `$ npm install ' + adapter + ' --save` to install it.');
              process.exit(1);
            }
          }
        });

        // Check if the adapter in every connections exists.
        _.forEach(strapi.config.orm.connections, function (settings, name) {
          if (!_.has(strapi.config.orm.adapters, settings.adapter)) {
            strapi.log.error('Unknown adapter `' + settings.adapter + '` for connection `' + name + '`.');
            process.exit(1);
          }
        });

        // Parse each models.
        _.forEach(strapi.models, function (definition, model) {
          _.bindAll(definition);

          // Make sure the model has a connection.
          // If not, use the default connection.
          if (_.isEmpty(definition.connection)) {
            definition.connection = strapi.config.orm.defaultConnection;
          }

          // Make sure this connection exists.
          if (!_.has(strapi.config.orm.connections, definition.connection)) {
            strapi.log.error('The connection `' + definition.connection + '` specified in the `' + model + '` model does not exist.');
            process.exit(1);
          }

          // Make sure this connection has a migrate strategy.
          // If not, use the `alter` strategy.
          if (!_.has(strapi.config.orm.connections[definition.connection], 'migrate')) {
            strapi.log.warn('The connection `' + definition.connection + '` does not have a migrate strategy.');
            strapi.log.warn('Setting the migrate strategy for `' + definition.connection + '` to `alter`.');
            strapi.config.orm.connections[definition.connection].migrate = 'alter';
          }

          // Apply the migrate strategy to the model.
          definition.migrate = strapi.config.orm.connections[definition.connection].migrate;

          // Derive information about this model's associations from its schema
          // and attach/expose the metadata as `SomeModel.associations` (an array).
          definition.associations = _.reduce(definition.attributes, function (associatedWith, attrDef, attrName) {
            if (typeof attrDef === 'object' && (attrDef.model || attrDef.collection)) {
              const assoc = {
                alias: attrName,
                type: attrDef.model ? 'model' : 'collection'
              };

              if (attrDef.model) {
                assoc.model = attrDef.model;
              }

              if (attrDef.collection) {
                assoc.collection = attrDef.collection;
              }

              if (attrDef.via) {
                assoc.via = attrDef.via;
              }

              associatedWith.push(assoc);
            }

            return associatedWith;
          }, []);

          // Finally, load the collection in the Waterline instance.
          try {
            strapi.orm.loadCollection(Waterline.Collection.extend(definition));
          } catch (err) {
            strapi.log.error('Impossible to register the `' + model + '` model.');
            process.exit(1);
          }
        });

        // Finally, initialize the Waterline ORM and
        // globally expose models.
        strapi.orm.initialize({
          adapters: strapi.adapters,
          models: strapi.models,
          connections: strapi.config.orm.connections,
          defaults: {
            connection: strapi.config.orm.defaultConnection
          }
        }, function () {
          if (strapi.config.globals.models === true) {
            _.forEach(strapi.models, function (definition, model) {
              const globalName = _.capitalize(strapi.models[model].globalId);
              global[globalName] = strapi.orm.collections[model];
            });
          }
        });

        // Parse each models and look for associations.
        _.forEach(strapi.orm.collections, function (definition, model) {
          _.forEach(definition.associations, function (association) {
            association.nature = helpers.getAssociationType(model, association);
          });
        });
      } else {
        strapi.log.warn('Waterline ORM disabled!');
      }

      cb();
    },

    /**
     * Reload the hook
     */

    reload: function () {
      hook.teardown(function () {
        hook.initialize(function (err) {
          if (err) {
            strapi.log.error('Failed to reinitialize the ORM hook.');
            strapi.stop();
          } else {
            strapi.emit('hook:waterline:reloaded');
          }
        });
      });
    },

    /**
     * Teardown adapters
     */

    teardown: function (cb) {
      cb = cb || function (err) {
        if (err) {
          strapi.log.error('Failed to teardown ORM adapters.');
          strapi.stop();
        }
      };
      async.forEach(Object.keys(strapi.adapters || {}), function (name, next) {
        if (strapi.adapters[name].teardown) {
          strapi.adapters[name].teardown(null, next);
        } else {
          next();
        }
      }, cb);
    }
  };

  return hook;
};