//! Original writing-note policy over Core-owned Note document analysis.
use research_workbench_native_sdk::{
    note_document::{
        NoteDocument, NoteDocumentAnalysis, NoteDocumentAnalysisResult, NoteDocumentBlock,
    },
    writing_file::{PreparedWritingNote, WritingNoteCatalogProjection},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WritingNote {
    schema_version: f64,
    note_id: String,
    blocks: Vec<NoteDocumentBlock>,
}

pub fn prepare_note(content: &str) -> Result<PreparedWritingNote, String> {
    let value: WritingNote = serde_json::from_str(content).map_err(|error| {
        let category = error.classify();
        let original = error.to_string();
        let safe_cause = if matches!(
            category,
            serde_json::error::Category::Syntax | serde_json::error::Category::Eof
        ) || original.starts_with("missing field ")
        {
            original
        } else {
            format!("结构类型错误（{category:?}）")
        };
        let code = if matches!(category, serde_json::error::Category::Data) {
            "writing_note_blocks_invalid"
        } else {
            "writing_note_json_invalid"
        };
        format!(
            "{code}：{safe_cause}（line={},column={}）；原始文件已保留。",
            error.line(),
            error.column()
        )
    })?;
    if value.schema_version != 1.0 {
        return Err("writing_note_version_invalid：不支持的写作笔记版本。".to_owned());
    }
    if value.note_id.is_empty() || value.note_id.encode_utf16().count() > 128 {
        return Err("writing_note_identity_invalid：写作笔记标识为空或过长。".to_owned());
    }
    let note_id = value.note_id;
    let document = NoteDocument {
        title: None,
        schema_version: 1,
        page_id: "projection".to_owned(),
        blocks: value.blocks,
    };
    Ok(PreparedWritingNote { note_id, document })
}

/// The caller binds this analysis to the prepared document before consumption.
pub fn finish_note(
    note: &PreparedWritingNote,
    analysis: &NoteDocumentAnalysis,
) -> Result<WritingNoteCatalogProjection, String> {
    fn visit(block: &NoteDocumentBlock, known: &[String]) -> Result<(), String> {
        let content = &block.content;
        if !known.iter().any(|kind| kind == &block.block_type)
            || matches!(
                block.block_type.as_str(),
                "childPage" | "readingNoteReference" | "researchObjectReference" | "unsupported"
            )
            || matches!(content["kind"].as_str(), Some("reference" | "unsupported"))
        {
            return Err("writing_note_block_unsupported：写作笔记包含不支持的块。".to_owned());
        }
        let mention = |items: &Value| {
            items
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["type"] == "mention"))
        };
        if content["kind"] == "inline" && mention(&content["items"])
            || content["kind"] == "table"
                && content["rows"].as_array().is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row.as_array()
                            .is_some_and(|cells| cells.iter().any(|cell| mention(&cell["items"])))
                    })
                })
        {
            return Err("writing_note_mention_unsupported：写作笔记不支持科研提及。".to_owned());
        }
        if content["kind"] == "asset" {
            let id = content["assetId"].as_str().unwrap_or_default();
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("writing_note_asset_invalid：写作笔记资源标识无效。".to_owned());
            }
        }
        for child in &block.children {
            visit(child, known)?;
        }
        Ok(())
    }
    for block in &note.document.blocks {
        visit(block, &analysis.known_block_types)?;
    }
    match &analysis.result {
        NoteDocumentAnalysisResult::Invalid { cause } => {
            Err(format!("writing_note_blocks_invalid：{cause}"))
        }
        NoteDocumentAnalysisResult::Ready { text, folded_text } => {
            Ok(WritingNoteCatalogProjection::Ready {
                note_id: note.note_id.clone(),
                text: text.clone(),
                folded_text: folded_text.clone(),
            })
        }
    }
}
