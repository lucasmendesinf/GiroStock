-- Lojas adicionais de um usuario: users.location_id continua sendo a loja principal e
-- esta tabela guarda as outras lojas em que a mesma pessoa tambem atua.
CREATE TABLE user_locations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (user_id, location_id)
);
CREATE INDEX idx_user_locations_location ON user_locations(location_id);
