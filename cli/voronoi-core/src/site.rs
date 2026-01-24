//! Site and position types for Voronoi computation.

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
    pub fn random() -> Self {
        use std::f64::consts::TAU;
        Self::from_angle(rand::random::<f64>() * TAU)
    }

    /// Reflect off horizontal boundary
    pub fn reflect_x(&mut self) {
        self.x = -self.x;
    }

    /// Reflect off vertical boundary
    pub fn reflect_y(&mut self) {
        self.y = -self.y;
    }
}

/// A Voronoi site with position and velocity
#[derive(Debug, Clone)]
pub struct Site {
    pub pos: Position,
    pub vel: Velocity,
}

impl Site {
    pub fn new(pos: Position, vel: Velocity) -> Self {
        Self { pos, vel }
    }

    /// Create with random velocity
    pub fn with_random_velocity(pos: Position) -> Self {
        Self {
            pos,
            vel: Velocity::random(),
        }
    }

    /// Move site by velocity * speed * dt, bouncing off boundaries
    pub fn step(&mut self, speed: f64, dt: f64, width: f64, height: f64) {
        let movement = speed * dt;

        self.pos.x += self.vel.x * movement;
        self.pos.y += self.vel.y * movement;

        // Bounce off edges
        if self.pos.x < 0.0 || self.pos.x >= width {
            self.vel.reflect_x();
            self.pos.x = self.pos.x.clamp(0.0, width - 1.0);
        }
        if self.pos.y < 0.0 || self.pos.y >= height {
            self.vel.reflect_y();
            self.pos.y = self.pos.y.clamp(0.0, height - 1.0);
        }
    }

    /// Split into two sites moving in opposite directions
    pub fn split(&self) -> (Site, Site) {
        let angle = rand::random::<f64>() * std::f64::consts::TAU;
        let vel1 = Velocity::from_angle(angle);
        let vel2 = Velocity::from_angle(angle + std::f64::consts::PI);

        (
            Site::new(self.pos, vel1),
            Site::new(self.pos, vel2),
        )
    }
}

/// Collection of sites with physics simulation
#[derive(Debug, Clone)]
pub struct SiteCollection {
    pub sites: Vec<Site>,
    pub fractional_sites: f64,  // Accumulated fractional sites for gradual growth
}

impl SiteCollection {
    pub fn new(sites: Vec<Site>) -> Self {
        Self {
            sites,
            fractional_sites: 0.0,
        }
    }

    /// Create sites at random positions with random velocities
    pub fn random(count: usize, width: f64, height: f64) -> Self {
        let sites = (0..count)
            .map(|_| {
                let pos = Position::new(
                    rand::random::<f64>() * width,
                    rand::random::<f64>() * height,
                );
                Site::with_random_velocity(pos)
            })
            .collect();
        Self::new(sites)
    }

    /// Step all sites forward
    pub fn step(&mut self, speed: f64, dt: f64, width: f64, height: f64) {
        for site in &mut self.sites {
            site.step(speed, dt, width, height);
        }
    }

    /// Gradually adjust site count toward target using exponential growth/decay
    ///
    /// Returns indices of newly added sites (for split) or removed sites
    pub fn adjust_count(
        &mut self,
        target: usize,
        doubling_time: f64,
        dt: f64,
        cell_areas: Option<&[u32]>,
    ) -> (Vec<usize>, Vec<usize>) {
        if doubling_time <= 0.0 || target == self.sites.len() {
            return (vec![], vec![]);
        }

        let current = self.sites.len();
        let growing = target > current;

        // Rate: ln(2) / doubling_time gives exponential growth with specified doubling time
        let rate = std::f64::consts::LN_2 / doubling_time;
        let expected_change = current as f64 * rate * dt;
        self.fractional_sites += expected_change;

        let mut added = vec![];
        let mut removed = vec![];

        while self.fractional_sites >= 1.0 {
            self.fractional_sites -= 1.0;

            if growing && self.sites.len() < target {
                // Split: pick site with largest area (or random if no areas)
                let src_idx = if let Some(areas) = cell_areas {
                    areas
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| *i < self.sites.len())
                        .max_by_key(|(_, &area)| area)
                        .map(|(i, _)| i)
                        .unwrap_or(0)
                } else {
                    (rand::random::<f64>() * self.sites.len() as f64) as usize
                };

                let (site1, site2) = self.sites[src_idx].split();
                self.sites[src_idx] = site1;
                self.sites.push(site2);
                added.push(self.sites.len() - 1);
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

    /// Find site with the closest neighbor (most "redundant" spatially)
    fn find_closest_neighbor_site(&self) -> usize {
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
                (rand::random::<f64>() * self.sites.len() as f64) as usize
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

    /// Get positions as a slice (for Voronoi computation)
    pub fn positions(&self) -> Vec<Position> {
        self.sites.iter().map(|s| s.pos).collect()
    }
}
