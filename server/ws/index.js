const setupDeviceSocket = require('./deviceSocket');
const setupDashboardSocket = require('./dashboardSocket');

module.exports = function setupWebSockets(io) {
  const deviceNs = setupDeviceSocket(io);
  const dashboardNs = setupDashboardSocket(io);

  /*
   * ⚠️ THE MESH NAMESPACE IS NOT CREATED UNLESS THE FLAG IS ON.
   *
   * Not a disabled handler, not one that returns early — required and registered only when
   * MESH_ACCEPT_ENROLLMENT is set. With the flag off there is no /mesh endpoint to reach and no code
   * loaded, which is what "a user who never sets it must not be able to tell the mesh exists" means
   * in practice (I1). An early-returning handler would still answer the socket and still be a surface.
   *
   * Required INSIDE the branch for the same reason: a top-level require would load the transport,
   * its client library and the backpressure accounting into every ordinary install's memory to do
   * nothing.
   */
  let meshNs = null;
  const config = require('../config');
  if (config.meshAcceptEnrollment) {
    try {
      const setupMeshSocket = require('./meshSocket');
      const store = require('../lib/mesh/store');
      const { db } = require('../db/database');

      const thisNodeId = store.ensureNodeIdentity(db);
      if (!thisNodeId) {
        console.warn('[mesh] MESH_ACCEPT_ENROLLMENT is set but this node has no identity yet — ' +
                     'the mesh tables are missing. Skipping the mesh listener.');
      } else {
        meshNs = setupMeshSocket(io, {
          thisNodeId,
          acceptEnrollment: () => true,
          findEdgeByTokenHash: (hash) => store.findEdgeByTokenHash(db, hash),
          /*
           * Phase 1 delivers the payload and records that the edge is alive. STORING mirrored rows is
           * Phase 2 (upward aggregation), which defines what is kept and for how long — writing a
           * guess at that now would be a schema someone has to live with.
           */
          onEnvelope: (edge) => store.touchEdge(db, edge.id),
        });
        console.log(`[mesh] listening for child nodes as ${thisNodeId}`);
      }
    } catch (e) {
      /*
       * ⚠️ The mesh must never be the reason a server fails to boot. It is an optional observer
       * relationship; the node's own job — scheduling, playback, its local dashboard — is unaffected
       * by it being unavailable (I1).
       */
      console.warn(`[mesh] listener not started: ${e && e.message}`);
    }
  }

  return { deviceNs, dashboardNs, meshNs };
};
