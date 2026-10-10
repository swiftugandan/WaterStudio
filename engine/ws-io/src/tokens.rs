//! EPANET's line tokeniser (`gettokens` in input2.c).

/// EPANET reads at most this many tokens from a line (MAXTOKS).
pub const MAX_TOKENS: usize = 40;
/// EPANET reads at most this many characters of a line (MAXLINE).
pub const MAX_LINE: usize = 1024;

/// A tokenised input line.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Line {
    pub tokens: Vec<String>,
    /// Text after the first ';', without its line ending; `None` if there is no ';'
    /// or nothing follows it.
    pub comment: Option<String>,
}

/// Split a line the way EPANET does: everything after the first ';' is a comment;
/// tokens are separated by spaces, tabs and line endings; a token that begins with a
/// double quote runs to the next double quote (or the end of the line).
pub fn tokenize(line: &str) -> Line {
    let (body, comment) = match line.find(';') {
        Some(i) => {
            let rest = &line[i + 1..];
            let end = rest.find(['\n', '\r']).unwrap_or(rest.len());
            let text = &rest[..end];
            (&line[..i], (!text.is_empty()).then(|| text.to_string()))
        }
        None => (line, None),
    };

    let mut tokens = Vec::new();
    let bytes = body.as_bytes();
    let is_sep = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | b'\r');
    let mut i = 0;
    while i < bytes.len() && tokens.len() < MAX_TOKENS {
        if is_sep(bytes[i]) {
            i += 1;
            continue;
        }
        if bytes[i] == b'"' {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && !matches!(bytes[end], b'"' | b'\n' | b'\r') {
                end += 1;
            }
            tokens.push(body[start..end].to_string());
            i = end + 1;
        } else {
            let start = i;
            while i < bytes.len() && !is_sep(bytes[i]) {
                i += 1;
            }
            tokens.push(body[start..i].to_string());
        }
    }
    Line { tokens, comment }
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_whitespace_and_keeps_the_comment() {
        let l = tokenize(" J1\t100  25 ;  main street\r\n");
        assert_eq!(l.tokens, ["J1", "100", "25"]);
        assert_eq!(l.comment.as_deref(), Some("  main street"));
    }

    #[test]
    fn quoted_tokens_keep_their_spaces() {
        let l = tokenize(r#"1.5 2.5 "Pump station" N1"#);
        assert_eq!(l.tokens, ["1.5", "2.5", "Pump station", "N1"]);
    }

    #[test]
    fn empty_comment_is_none() {
        assert_eq!(tokenize("A 1 ;").comment, None);
        assert!(tokenize(";; header").tokens.is_empty());
    }
}
