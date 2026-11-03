-- How many of a bucket's samples carried a number: the weight its mean has when buckets are
-- combined into a longer one. NULL on rows written before this column, which fall back to `samples`.
ALTER TABLE state_rollups ADD COLUMN numeric_samples INTEGER;
