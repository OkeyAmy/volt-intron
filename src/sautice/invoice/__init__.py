"""Invoice drafting: resolve spoken sales against a workspace roster and compute
totals with the integer-kobo money engine. The LLM (or heuristic) only proposes
structure; every naira figure and every resolution decision is made here, and
anything uncertain becomes a question rather than a silent guess.
"""
