export interface FeedlotRow {
  id: number;
  field_id: number;
  user_id: number;
  name: string;
  capacity: number | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  // Joined
  field_name?: string;
}

export interface CorralRow {
  id: number;
  feedlot_id: number;
  name: string;
  capacity: number | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  // Joined
  feedlot_name?: string;
  field_name?: string;
  field_id?: number;
}
