/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


/*
 * 2.2.15 RemoteHost
 *
 * This variable represents the source of inbound IP packets. This will be a wildcard in most cases
 * (i.e. an empty string). NAT vendors are only required to support wildcards. A non-wildcard value
 * will allow for “narrow” port mappings, which may be desirable in some usage scenarios.When
 * RemoteHost is a wildcard, all traffic sent to the ExternalPort on the WAN interface of the
 * gateway is forwarded to the InternalClient on the InternalPort. When RemoteHost is
 * specified as one external IP address as opposed to a wildcard, the NAT will only forward inbound
 * packets from this RemoteHost to the InternalClient, all other packets will be dropped.
 *
 * http://upnp.org/specs/gw/UPnP-gw-WANIPConnection-v1-Service.pdf
 */

'use strict';
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

const natUpnp = require('../extension/upnp/nat-upnp');

const cfg = require('../net2/config.js');

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager('info');

const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

function compareUpnp(a, b) {
  return a.public && b.public &&
         a.private && b.private &&
         a.public.port  == b.public.port &&
         a.private.host == b.private.host &&
         a.private.port == b.private.port &&
         a.protocol     == b.protocol;
}

class UPNPSensor extends Sensor {
  constructor() {
    super();
    this.config = cfg.getConfig().sensors.UPNPSensor;
    this.upnpClient = natUpnp.createClient();
  }

  run() {
    setInterval(() => {
      this.upnpClient.getMappings(async (err, results) => {
        if (results && results.length >= 0) {
          const key = "sys:scan:nat";

          let preMappings = await (rclient.hmgetAsync(key, 'upnp')
            .then(entries => { return JSON.parse(entries) })
            .catch(err => log.error("Failed to update upnp mapping in database: " + err))
          );

          results.forEach(current => {
            if (!preMappings.some(pre => compareUpnp(current, pre))) {
              let alarm = new Alarm.UpnpAlarm(
                new Date() / 1000,
                current.private.host,
                {
                  'p.source': 'UPNPSensor',
                  'p.device.ip': current.private.host,
                  'p.upnp.public.host'  : current.public.host,
                  'p.upnp.public.port'  : current.public.port,
                  'p.upnp.private.host' : current.private.host,
                  'p.upnp.private.port' : current.private.port,
                  'p.upnp.protocol'     : current.protocol.toUpperCase(),
                  'p.upnp.enabled'      : current.enabled,
                  'p.upnp.description'  : current.description,
                  'p.upnp.ttl'          : current.ttl,
                  'p.upnp.local'        : current.local
                }
              );
              am2.enrichDeviceInfo(alarm)
                .then(enriched => {
                  am2.enqueueAlarm(enriched)
                })
            }
          })

          rclient.hmsetAsync(key, {upnp: JSON.stringify(results)} )
            .catch(err => log.error("Failed to update upnp mapping in database: " + err))
            .then(writes => writes && log.info("UPNP mapping is updated,", results.length, "entries"));

        } else {
          log.info("No upnp mapping found in network");
        }
      });
    }, this.config.interval || 60 * 10 * 1000); // default to 10 minutes
  }
}

module.exports = UPNPSensor;
