CREATE TABLE bsd_play_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  name text NOT NULL,
  analysis_id uuid REFERENCES bsd_game_analyses(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE bsd_play_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own play sets" ON bsd_play_sets
  FOR ALL USING (auth.uid() = user_id);
