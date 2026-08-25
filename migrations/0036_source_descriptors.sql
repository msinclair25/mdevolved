-- MD2 source descriptors are additive, nullable metadata. Existing vaults and
-- snapshot rows remain valid and resolve to the legacy Obsidian source when
-- the descriptor is absent.
--
-- The JSON is provider-neutral: it contains no credentials, grants, sessions,
-- hostnames, D1 identifiers, or R2 object keys. Portable snapshots add an
-- explicit quarantined/inert disposition and never restore this metadata as
-- live authority.

ALTER TABLE vaults
  ADD COLUMN source_descriptor_json TEXT
  CHECK (source_descriptor_json IS NULL OR json_valid(source_descriptor_json));

ALTER TABLE snapshot_vaults
  ADD COLUMN source_descriptor_json TEXT
  CHECK (source_descriptor_json IS NULL OR json_valid(source_descriptor_json));

