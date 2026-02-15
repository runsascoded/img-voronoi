//! Site and position types for Voronoi computation.

use std::fmt;
use rand::Rng;
use rand_chacha::ChaCha8Rng;
use rand::SeedableRng;

/// Strategy for adding new sites when growing
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SplitStrategy {
    /// Split the largest cell (children at parent position)
    Max,
    /// Weighted random split proportional to cell area
    Weighted,
    /// Split the most isolated site (furthest from any neighbor)
    Isolated,
    /// Spawn new site at centroid of the largest cell
    Centroid,
    /// Spawn new site at the point furthest from any site
    Farthest,
    /// Poisson distance-threshold: sites spawn at centroids of large cells,
    /// but only when well-spaced from neighbors. Rate scales with excess spacing.
    /// Parameters: (threshold_k, lambda)
    ///   threshold_k: multiplier on expected spacing sqrt(area/n); ~1.0-2.0
    ///   lambda: Poisson rate; higher = more aggressive spawning when eligible
    Poisson(f64, f64),
}

impl fmt::Display for SplitStrategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SplitStrategy::Max => write!(f, "max"),
            SplitStrategy::Weighted => write!(f, "weighted"),
            SplitStrategy::Isolated => write!(f, "isolated"),
            SplitStrategy::Centroid => write!(f, "centroid"),
            SplitStrategy::Farthest => write!(f, "farthest"),
            SplitStrategy::Poisson(k, l) => write!(f, "poisson({},{})", k, l),
        }
    }
}

impl std::str::FromStr for SplitStrategy {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        let lower = s.to_lowercase();
        match lower.as_str() {
            "max" => Ok(SplitStrategy::Max),
            "weighted" => Ok(SplitStrategy::Weighted),
            "isolated" => Ok(SplitStrategy::Isolated),
            "centroid" => Ok(SplitStrategy::Centroid),
            "farthest" => Ok(SplitStrategy::Farthest),
            _ if lower.starts_with("poisson") => {
                // Parse "poisson" (defaults) or "poisson(k,lambda)"
                if let Some(params) = lower.strip_prefix("poisson(").and_then(|s| s.strip_suffix(')')) {
                    let parts: Vec<&str> = params.split(',').collect();
                    if parts.len() == 2 {
                        let k = parts[0].trim().parse::<f64>().map_err(|e| format!("bad threshold_k: {}", e))?;
                        let l = parts[1].trim().parse::<f64>().map_err(|e| format!("bad lambda: {}", e))?;
                        Ok(SplitStrategy::Poisson(k, l))
                    } else {
                        Err(format!("poisson expects 2 params: poisson(k,lambda), got {}", parts.len()))
                    }
                } else if lower == "poisson" {
                    Ok(SplitStrategy::Poisson(1.0, 3.0))
                } else {
                    Err(format!("invalid poisson syntax: '{}', expected poisson or poisson(k,lambda)", s))
                }
            }
            _ => Err(format!(
                "unknown split strategy: '{}' (expected max, weighted, isolated, centroid, farthest, or poisson)", s
            )),
        }
    }
}

/// 2D position
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

impl Position {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Squared distance to another position
    pub fn dist_sq(&self, other: &Position) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        dx * dx + dy * dy
    }

    /// Distance to another position
    pub fn dist(&self, other: &Position) -> f64 {
        self.dist_sq(other).sqrt()
    }
}

/// Unit velocity vector (magnitude 1)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Velocity {
    pub x: f64,
    pub y: f64,
}

impl Velocity {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Create from angle in radians
    pub fn from_angle(angle: f64) -> Self {
        Self {
            x: angle.cos(),
            y: angle.sin(),
        }
    }

    /// Create random unit velocity
    pub fn random(rng: &mut impl Rng) -> Self {
        use std::f64::consts::TAU;
        Self::from_angle(rng.gen::<f64>() * TAU)
    }

    /// Current angle in radians
    pub fn angle(&self) -> f64 {
        self.y.atan2(self.x)
    }

    /// Reflect off vertical boundary (left/right edge)
    pub fn reflect_x(&mut self) {
        self.x = -self.x;
    }

    /// Reflect off horizontal boundary (top/bottom edge)
    pub fn reflect_y(&mut self) {
        self.y = -self.y;
    }
}

/// A Voronoi site with position, velocity, and dynamics
#[derive(Debug, Clone)]
pub struct Site {
    pub pos: Position,
    pub vel: Velocity,
    /// Angular velocity (rad/s) — randomly perturbed each step for organic curved motion
    pub turn_rate: f64,
    /// Speed multiplier, decays toward 1.0 (used for split boost)
    pub speed_mult: f64,
}

impl Site {
    pub fn new(pos: Position, vel: Velocity) -> Self {
        Self { pos, vel, turn_rate: 0.0, speed_mult: 1.0 }
    }

    /// Create with random velocity
    pub fn with_random_velocity(pos: Position, rng: &mut impl Rng) -> Self {
        Self {
            pos,
            vel: Velocity::random(rng),
            turn_rate: 0.0,
            speed_mult: 1.0,
        }
    }

    /// Move site by velocity * speed * dt, with smooth random steering and edge bouncing
    pub fn step(&mut self, speed: f64, dt: f64, width: f64, height: f64, rng: &mut impl Rng) {
        // Rotate velocity direction by turn_rate
        let angle = self.vel.angle() + self.turn_rate * dt;
        self.vel = Velocity::from_angle(angle);

        // Ornstein-Uhlenbeck process on turn_rate: smooth random direction changes
        // theta = mean-reversion rate (how quickly turn_rate drifts back to 0)
        // sigma = volatility (magnitude of random perturbation)
        let theta = 3.0;
        let sigma = 3.0;
        let noise: f64 = rng.gen_range(-1.73..1.73);
        self.turn_rate += -theta * self.turn_rate * dt + sigma * dt.sqrt() * noise;

        // Decay speed multiplier toward 1.0 (half-life ~0.14s)
        self.speed_mult = 1.0 + (self.speed_mult - 1.0) * (-5.0 * dt).exp();

        // Move
        let movement = speed * self.speed_mult * dt;
        self.pos.x += self.vel.x * movement;
        self.pos.y += self.vel.y * movement;

        // Bounce off edges
        if self.pos.x < 0.0 || self.pos.x >= width {
            self.vel.reflect_x();
            self.turn_rate = -self.turn_rate;
            self.pos.x = self.pos.x.clamp(0.0, width - 1.0);
        }
        if self.pos.y < 0.0 || self.pos.y >= height {
            self.vel.reflect_y();
            self.turn_rate = -self.turn_rate;
            self.pos.y = self.pos.y.clamp(0.0, height - 1.0);
        }
    }

    /// Split into two sites at the same position, moving in opposite directions.
    /// Children separate gradually via velocity + speed boost.
    ///
    /// If `centroid` is provided, one child is aimed toward the centroid (the cell's
    /// center of mass, which is the direction of the most empty space).
    pub fn split(&self, centroid: Option<&Position>, rng: &mut impl Rng) -> (Site, Site) {
        let angle = if let Some(c) = centroid {
            let dx = c.x - self.pos.x;
            let dy = c.y - self.pos.y;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > 1.0 {
                dy.atan2(dx)
            } else {
                rng.gen::<f64>() * std::f64::consts::TAU
            }
        } else {
            rng.gen::<f64>() * std::f64::consts::TAU
        };
        let vel1 = Velocity::from_angle(angle);
        let vel2 = Velocity::from_angle(angle + std::f64::consts::PI);

        // Opposite turn rates so children curve away from each other, plus speed boost
        let turn = rng.gen_range(1.0..4.0);
        (
            Site { pos: self.pos, vel: vel1, turn_rate: turn, speed_mult: 3.0 },
            Site { pos: self.pos, vel: vel2, turn_rate: -turn, speed_mult: 3.0 },
        )
    }
}

/// Collection of sites with physics simulation and seeded RNG
#[derive(Debug, Clone)]
pub struct SiteCollection {
    pub sites: Vec<Site>,
    pub fractional_sites: f64,
    rng: ChaCha8Rng,
}

impl SiteCollection {
    pub fn new(sites: Vec<Site>, seed: u64) -> Self {
        Self {
            sites,
            fractional_sites: 0.0,
            rng: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    /// Create sites at random positions with random velocities
    pub fn random(count: usize, width: f64, height: f64, seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let sites = (0..count)
            .map(|_| {
                let pos = Position::new(
                    rng.gen::<f64>() * width,
                    rng.gen::<f64>() * height,
                );
                Site::with_random_velocity(pos, &mut rng)
            })
            .collect();
        Self {
            sites,
            fractional_sites: 0.0,
            rng,
        }
    }

    /// Average velocity vector across all sites (for drift detection)
    pub fn avg_velocity(&self) -> (f64, f64) {
        if self.sites.is_empty() { return (0.0, 0.0); }
        let n = self.sites.len() as f64;
        let (sx, sy) = self.sites.iter().fold((0.0, 0.0), |(ax, ay), s| {
            (ax + s.vel.x * s.speed_mult, ay + s.vel.y * s.speed_mult)
        });
        (sx / n, sy / n)
    }

    /// Step all sites forward (index-based to allow disjoint borrows of sites + rng)
    ///
    /// If `centroids` and `centroid_pull` > 0, each site's velocity is steered
    /// toward its cell centroid (continuous Lloyd's relaxation).
    pub fn step(
        &mut self,
        speed: f64,
        dt: f64,
        width: f64,
        height: f64,
        centroids: Option<&[Position]>,
        centroid_pull: f64,
    ) {
        if centroid_pull > 0.0 {
            if let Some(centroids) = centroids {
                let n = self.sites.len().min(centroids.len());
                for i in 0..n {
                    let site = &mut self.sites[i];
                    let c = &centroids[i];
                    let dx = c.x - site.pos.x;
                    let dy = c.y - site.pos.y;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist > 0.5 {
                        // Blend velocity toward centroid direction
                        let target_angle = dy.atan2(dx);
                        let current_angle = site.vel.angle();
                        let mut delta = target_angle - current_angle;
                        // Normalize to [-PI, PI]
                        while delta > std::f64::consts::PI { delta -= std::f64::consts::TAU; }
                        while delta < -std::f64::consts::PI { delta += std::f64::consts::TAU; }
                        let steer = delta * centroid_pull * dt;
                        site.vel = Velocity::from_angle(current_angle + steer);
                    }
                }

            }
        }
        for i in 0..self.sites.len() {
            self.sites[i].step(speed, dt, width, height, &mut self.rng);
        }
    }

    /// Gradually adjust site count toward target using exponential growth/decay.
    ///
    /// For Poisson strategy, `img_area` is used to compute density-dependent threshold.
    /// Returns indices of newly added sites or removed sites.
    pub fn adjust_count(
        &mut self,
        target: usize,
        doubling_time: f64,
        dt: f64,
        cell_areas: Option<&[u32]>,
        split_strategy: SplitStrategy,
        centroids: Option<&[Position]>,
        farthest_point: Option<Position>,
        img_area: f64,
    ) -> (Vec<usize>, Vec<usize>) {
        if doubling_time <= 0.0 || target == self.sites.len() {
            return (vec![], vec![]);
        }

        let current = self.sites.len();
        let growing = target > current;

        // Poisson strategy: use exponential clock but gate spawns by NN distance.
        // Pre-compute eligible sites once, before the spawn loop.
        let poisson_eligible: Option<Vec<usize>> = if let SplitStrategy::Poisson(threshold_k, _lambda) = split_strategy {
            if growing {
                let expected_spacing = (img_area / current as f64).sqrt();
                let threshold = threshold_k * expected_spacing;
                let nn_dists = self.nearest_neighbor_dists();
                // Sites whose NN distance exceeds threshold are eligible to "trigger" a spawn
                let eligible: Vec<usize> = (0..current)
                    .filter(|&i| nn_dists[i] > threshold)
                    .collect();
                Some(eligible)
            } else {
                None
            }
        } else {
            None
        };

        // Rate: ln(2) / doubling_time gives exponential growth with specified doubling time
        let rate = std::f64::consts::LN_2 / doubling_time;
        let expected_change = current as f64 * rate * dt;
        self.fractional_sites += expected_change;

        // For Poisson, cap buffered spawns to prevent burst after eligibility clears
        if matches!(split_strategy, SplitStrategy::Poisson(_, _)) {
            let max_buffered = (current as f64 * 0.1).max(2.0);
            self.fractional_sites = self.fractional_sites.min(max_buffered);
        }

        let mut added = vec![];
        let mut removed = vec![];

        // Local mutable copy of areas: after each split, we zero the split cell's weight
        // so it can't be re-selected (without-replacement sampling, max one split per site per frame).
        let mut local_areas: Vec<u64> = cell_areas
            .map(|a| a.iter().map(|&v| v as u64).collect())
            .unwrap_or_default();
        // Track already-split sites for Isolated strategy
        let mut split_mask: Vec<bool> = vec![false; self.sites.len()];

        while self.fractional_sites >= 1.0 {
            self.fractional_sites -= 1.0;

            if growing && self.sites.len() < target {
                // Poisson gating: if no sites are eligible, defer spawn (buffer fractional_sites)
                if let Some(ref eligible) = poisson_eligible {
                    if eligible.is_empty() {
                        self.fractional_sites += 1.0;
                        break;
                    }
                }

                match split_strategy {
                    // Poisson: spawn at centroid of largest cell (like Centroid), gated by NN distance
                    SplitStrategy::Poisson(_, _) |
                    // Spawn strategies: create a new site at a computed position
                    SplitStrategy::Centroid => {
                        // Spawn at centroid of largest cell
                        let pos = if let (Some(areas), Some(cents)) = (cell_areas, centroids) {
                            let n = self.sites.len().min(areas.len()).min(cents.len());
                            let mut max_area = 0u32;
                            let mut idx = 0;
                            for i in 0..n {
                                if !split_mask.get(i).copied().unwrap_or(false) && areas[i] > max_area {
                                    max_area = areas[i];
                                    idx = i;
                                }
                            }
                            if idx < split_mask.len() { split_mask[idx] = true; }
                            cents[idx]
                        } else {
                            // Fallback: random position
                            Position::new(
                                self.rng.gen::<f64>() * 100.0,
                                self.rng.gen::<f64>() * 100.0,
                            )
                        };
                        self.sites.push(Site::with_random_velocity(pos, &mut self.rng));
                        added.push(self.sites.len() - 1);
                    }
                    SplitStrategy::Farthest => {
                        // Spawn at the point furthest from any site
                        let pos = farthest_point.unwrap_or_else(|| Position::new(
                            self.rng.gen::<f64>() * 100.0,
                            self.rng.gen::<f64>() * 100.0,
                        ));
                        self.sites.push(Site::with_random_velocity(pos, &mut self.rng));
                        added.push(self.sites.len() - 1);
                    }
                    // Split strategies: split an existing site into two children
                    _ => {
                        let src_idx = match split_strategy {
                            SplitStrategy::Isolated => {
                                self.find_most_isolated_site(&split_mask)
                            }
                            _ if local_areas.is_empty() => {
                                self.rng.gen_range(0..self.sites.len())
                            }
                            _ => {
                                let n = self.sites.len().min(local_areas.len());
                                match split_strategy {
                                    SplitStrategy::Max => {
                                        let mut max_area = 0u64;
                                        let mut idx = 0;
                                        for (i, &area) in local_areas[..n].iter().enumerate() {
                                            if area > max_area {
                                                max_area = area;
                                                idx = i;
                                            }
                                        }
                                        if max_area > 0 { idx } else { self.rng.gen_range(0..self.sites.len()) }
                                    }
                                    SplitStrategy::Weighted => {
                                        let total: u64 = local_areas[..n].iter().sum();
                                        if total > 0 {
                                            let r = self.rng.gen_range(0..total);
                                            let mut cum = 0u64;
                                            let mut idx = 0;
                                            for (i, &area) in local_areas[..n].iter().enumerate() {
                                                cum += area;
                                                if r < cum {
                                                    idx = i;
                                                    break;
                                                }
                                            }
                                            idx
                                        } else {
                                            self.rng.gen_range(0..self.sites.len())
                                        }
                                    }
                                    _ => unreachable!(),
                                }
                            }
                        };

                        let centroid = centroids.and_then(|c| c.get(src_idx));
                        let (site1, site2) = self.sites[src_idx].split(centroid, &mut self.rng);
                        self.sites[src_idx] = site1;
                        self.sites.push(site2);
                        added.push(self.sites.len() - 1);

                        if src_idx < split_mask.len() {
                            split_mask[src_idx] = true;
                        }
                        if src_idx < local_areas.len() {
                            local_areas[src_idx] = 0;
                        }
                    }
                }
            } else if !growing && self.sites.len() > target {
                // Remove site with closest neighbor (maintains spatial distribution)
                let remove_idx = self.find_closest_neighbor_site();
                removed.push(remove_idx);
                self.sites.remove(remove_idx);
            }
        }

        if self.sites.len() == target {
            self.fractional_sites = 0.0;
        }

        (added, removed)
    }


    /// Compute nearest-neighbor distance for each site using a spatial grid (O(n) expected).
    fn nearest_neighbor_dists(&self) -> Vec<f64> {
        let n = self.sites.len();
        if n <= 1 {
            return vec![f64::INFINITY; n];
        }

        // Find bounding box
        let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
        let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for s in &self.sites {
            min_x = min_x.min(s.pos.x);
            min_y = min_y.min(s.pos.y);
            max_x = max_x.max(s.pos.x);
            max_y = max_y.max(s.pos.y);
        }
        let w = (max_x - min_x).max(1.0);
        let h = (max_y - min_y).max(1.0);

        // Grid with cell size ≈ expected spacing, so neighbors are in adjacent cells
        let grid_size = (n as f64).sqrt().ceil() as usize;
        let cell_w = w / grid_size as f64;
        let cell_h = h / grid_size as f64;
        let cols = grid_size;
        let rows = grid_size;

        // Build grid: each cell contains a list of site indices
        let mut grid: Vec<Vec<usize>> = vec![vec![]; cols * rows];
        for (i, s) in self.sites.iter().enumerate() {
            let cx = ((s.pos.x - min_x) / cell_w).min((cols - 1) as f64) as usize;
            let cy = ((s.pos.y - min_y) / cell_h).min((rows - 1) as f64) as usize;
            grid[cy * cols + cx].push(i);
        }

        // For each site, search expanding rings until we can guarantee nearest found
        let mut dists = vec![f64::INFINITY; n];
        for i in 0..n {
            let sx = self.sites[i].pos.x;
            let sy = self.sites[i].pos.y;
            let cx = ((sx - min_x) / cell_w).min((cols - 1) as f64) as usize;
            let cy = ((sy - min_y) / cell_h).min((rows - 1) as f64) as usize;

            let mut best = f64::INFINITY;
            // Check ring 0, then ring 1, etc., until ring's min possible distance > best
            for ring in 0..=(cols.max(rows)) {
                let min_ring_dist = if ring == 0 { 0.0 } else {
                    let dx = ((ring as f64 - 1.0) * cell_w).max(0.0);
                    let dy = ((ring as f64 - 1.0) * cell_h).max(0.0);
                    (dx * dx + dy * dy).sqrt()
                };
                if min_ring_dist > best { break; }

                let r0 = cy.saturating_sub(ring);
                let r1 = (cy + ring).min(rows - 1);
                let c0 = cx.saturating_sub(ring);
                let c1 = (cx + ring).min(cols - 1);
                for gy in r0..=r1 {
                    for gx in c0..=c1 {
                        // Only visit cells on the ring boundary (skip interior for ring > 0)
                        if ring > 0 && gy > r0 && gy < r1 && gx > c0 && gx < c1 { continue; }
                        for &j in &grid[gy * cols + gx] {
                            if j == i { continue; }
                            let dx = sx - self.sites[j].pos.x;
                            let dy = sy - self.sites[j].pos.y;
                            let d = (dx * dx + dy * dy).sqrt();
                            if d < best { best = d; }
                        }
                    }
                }
            }
            dists[i] = best;
        }
        dists
    }

    /// Find site with the closest neighbor (most "redundant" spatially)
    fn find_closest_neighbor_site(&mut self) -> usize {
        if self.sites.len() <= 1 {
            return 0;
        }

        let sample_size = self.sites.len().min(100);
        let use_full_scan = self.sites.len() <= 100;

        let mut min_closest_dist = f64::INFINITY;
        let mut remove_idx = 0;

        for i in 0..if use_full_scan { self.sites.len() } else { sample_size } {
            let idx = if use_full_scan {
                i
            } else {
                self.rng.gen_range(0..self.sites.len())
            };

            let site = &self.sites[idx];
            let mut closest_dist = f64::INFINITY;

            for (j, other) in self.sites.iter().enumerate() {
                if idx == j {
                    continue;
                }
                let dist = site.pos.dist_sq(&other.pos);
                if dist < closest_dist {
                    closest_dist = dist;
                }
            }

            if closest_dist < min_closest_dist {
                min_closest_dist = closest_dist;
                remove_idx = idx;
            }
        }

        remove_idx
    }

    /// Find site with the largest nearest-neighbor distance (most isolated).
    /// Skips sites already marked in `split_mask`.
    fn find_most_isolated_site(&self, split_mask: &[bool]) -> usize {
        let n = self.sites.len();
        if n <= 1 {
            return 0;
        }

        let mut max_nn_dist = -1.0f64;
        let mut best_idx = 0;

        for i in 0..n {
            if i < split_mask.len() && split_mask[i] {
                continue;
            }
            let site = &self.sites[i];
            let mut nn_dist = f64::INFINITY;
            for (j, other) in self.sites.iter().enumerate() {
                if i == j { continue; }
                let d = site.pos.dist_sq(&other.pos);
                if d < nn_dist { nn_dist = d; }
            }
            if nn_dist > max_nn_dist {
                max_nn_dist = nn_dist;
                best_idx = i;
            }
        }

        best_idx
    }

    /// Get positions as a slice (for Voronoi computation)
    pub fn positions(&self) -> Vec<Position> {
        self.sites.iter().map(|s| s.pos).collect()
    }

    /// Get current site count
    pub fn len(&self) -> usize {
        self.sites.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.sites.is_empty()
    }
}
