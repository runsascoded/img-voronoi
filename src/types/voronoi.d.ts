declare module 'voronoi' {
  export interface Site {
    x: number
    y: number
  }

  export interface Vertex {
    x: number
    y: number
  }

  export interface Edge {
    lSite: Site | null
    rSite: Site | null
    va: Vertex
    vb: Vertex
  }

  export interface Halfedge {
    site: Site
    edge: Edge
    getStartpoint(): Vertex
    getEndpoint(): Vertex
  }

  export interface Cell {
    site: Site
    halfedges: Halfedge[]
  }

  export interface BoundingBox {
    xl: number
    xr: number
    yt: number
    yb: number
  }

  export interface Diagram {
    cells: Cell[]
    edges: Edge[]
    vertices: Vertex[]
  }

  export default class Voronoi {
    compute(sites: Site[], bbox: BoundingBox): Diagram
    recycle(diagram: Diagram): void
  }
}
