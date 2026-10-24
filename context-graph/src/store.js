/**
 * Location-tagged graph store.
 * Nodes: { id, content, tags: string[] }
 * Edges: { src, dst, label }
 * Location: { parent_chain: string[], depth: number, cluster_id: string }
 */

/**
 * @typedef {Object} Node
 * @property {string} id
 * @property {string} content
 * @property {string[]} tags
 * @property {Location} location
 */

/**
 * @typedef {Object} Edge
 * @property {string} src
 * @property {string} dst
 * @property {string} label
 * @property {Location} location
 */

/**
 * @typedef {Object} Location
 * @property {string[]} parent_chain
 * @property {number} depth
 * @property {string} cluster_id
 */

export class ContextGraphStore {
  constructor() {
    /** @type {Map<string, Node>} */
    this.nodes = new Map();
    /** @type {Edge[]} */
    this.edges = [];
  }

  /**
   * Write a node with location.
   * @param {string} id
   * @param {string} content
   * @param {string[]} tags
   * @param {Location} location
   * @returns {Node}
   */
  writeNode(id, content, tags, location) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Node id must be non-empty string');
    }
    if (typeof content !== 'string') {
      throw new Error('Node content must be string');
    }
    if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
      throw new Error('Node tags must be string array');
    }
    this._validateLocation(location);

    // Idempotent per event id: identical re-write is a no-op; different
    // content is a conflict (CONTEXT.md invariant).
    const existing = this.nodes.get(id);
    if (existing) {
      if (existing.content !== content || JSON.stringify(existing.tags) !== JSON.stringify(tags)) {
        throw new Error(`Node id '${id}' already exists with different content`);
      }
      return existing;
    }

    const node = { id, content, tags, location };
    this.nodes.set(id, node);
    return node;
  }

  /**
   * Write an edge with location.
   * @param {string} src
   * @param {string} dst
   * @param {string} label
   * @param {Location} location
   * @returns {Edge}
   */
  writeEdge(src, dst, label, location) {
    if (typeof src !== 'string' || !src.trim()) {
      throw new Error('Edge src must be non-empty string');
    }
    if (typeof dst !== 'string' || !dst.trim()) {
      throw new Error('Edge dst must be non-empty string');
    }
    if (typeof label !== 'string') {
      throw new Error('Edge label must be string');
    }
    this._validateLocation(location);

    const edge = { src, dst, label, location };
    this.edges.push(edge);
    return edge;
  }

  /**
   * Read a node by id.
   * @param {string} id
   * @returns {Node | undefined}
   */
  readNode(id) {
    return this.nodes.get(id);
  }

  /**
   * Read all edges from a source node.
   * @param {string} src
   * @returns {Edge[]}
   */
  readEdgesFrom(src) {
    return this.edges.filter(e => e.src === src);
  }

  /**
   * Read all edges to a destination node.
   * @param {string} dst
   * @returns {Edge[]}
   */
  readEdgesTo(dst) {
    return this.edges.filter(e => e.dst === dst);
  }

  /**
   * @private
   * @param {Location} location
   */
  _validateLocation(location) {
    if (!location || typeof location !== 'object') {
      throw new Error('Location must be object');
    }
    if (!Array.isArray(location.parent_chain)) {
      throw new Error('Location.parent_chain must be string array');
    }
    if (typeof location.depth !== 'number' || location.depth < 0) {
      throw new Error('Location.depth must be non-negative number');
    }
    if (typeof location.cluster_id !== 'string' || !location.cluster_id.trim()) {
      throw new Error('Location.cluster_id must be non-empty string');
    }
  }

  /**
   * Get node count.
   * @returns {number}
   */
  nodeCount() {
    return this.nodes.size;
  }

  /**
   * Get edge count.
   * @returns {number}
   */
  edgeCount() {
    return this.edges.length;
  }
}
